'use strict';

/**
 * reconciler.js
 * Engine for reconciling delivery plans with execution runs (.sdlc/execution/execute-*.json)
 * and TODO blockers (docs/TODO/*.md).
 */

const fs = require('node:fs');
const path = require('node:path');
const { computePlanHash } = require('../plan-hash.js');

/**
 * Normalize a relative or absolute file path for stable comparisons.
 * @param {string} p
 * @param {string} [repoPath]
 * @returns {string}
 */
function normalizePath(p, repoPath) {
  if (!p) return '';
  let clean = p.trim().replace(/\\/g, '/');
  if (repoPath) {
    const cleanRepo = repoPath.trim().replace(/\\/g, '/');
    if (clean.startsWith(cleanRepo)) {
      clean = clean.slice(cleanRepo.length);
    }
  }
  return clean.replace(/^\/+/, '');
}

/**
 * Scan a project's `.sdlc/execution` folder for `execute-*.json` files.
 * @param {string} repoPath
 * @returns {Array<{filePath: string, data: object}>}
 */
function loadExecutionRuns(repoPath) {
  const execDir = path.join(repoPath, '.sdlc', 'execution');
  if (!fs.existsSync(execDir)) return [];

  const results = [];
  try {
    const files = fs.readdirSync(execDir);
    for (const file of files) {
      if (file.startsWith('execute-') && file.endsWith('.json')) {
        const fullPath = path.join(execDir, file);
        try {
          const raw = fs.readFileSync(fullPath, 'utf8');
          const data = JSON.parse(raw);
          results.push({
            filePath: fullPath,
            relativeFile: path.join('.sdlc', 'execution', file).replace(/\\/g, '/'),
            data
          });
        } catch {
          // Ignore invalid or unparseable JSON files
        }
      }
    }
  } catch {
    // If directory cannot be read, return empty
  }
  return results;
}

/**
 * 3-Tier Matcher: matches an execution run to a plan in the project.
 * Tier 1: Exact normalized path match
 * Tier 2: Exact planHash match
 * Tier 3: Basename match
 *
 * @param {object} execData
 * @param {Array<object>} plans
 * @param {string} repoPath
 * @param {Map<string, string>} planHashMap - map of plan.filePath -> currentFileHash
 * @returns {object|null} Matched plan or null
 */
function matchExecutionToPlan(execData, plans, repoPath, planHashMap) {
  const execPlanPath = execData.planPath ? normalizePath(execData.planPath, repoPath) : '';
  const execHash = execData.planHash || '';

  // Tier 1: Exact normalized path match
  if (execPlanPath) {
    const directMatch = plans.find(p => normalizePath(p.filePath, repoPath) === execPlanPath);
    if (directMatch) return directMatch;
  }

  // Tier 2: Exact planHash match (preserves links when plans move to archived/)
  if (execHash) {
    const hashMatch = plans.find(p => {
      const currentHash = planHashMap.get(p.filePath);
      return currentHash && currentHash === execHash;
    });
    if (hashMatch) return hashMatch;
  }

  // Tier 3: Basename match
  if (execPlanPath) {
    const execBase = path.basename(execPlanPath);
    const baseMatch = plans.find(p => path.basename(p.filePath) === execBase);
    if (baseMatch) return baseMatch;
  }

  return null;
}

/**
 * Reconcile tasks in a plan with an execution run.
 * @param {object} plan
 * @param {object} execData
 * @param {string} runRelativePath
 */
function applyExecutionToPlan(plan, execData, runRelativePath, currentPlanHash) {
  const isPristine = Boolean(currentPlanHash && execData.planHash && execData.planHash === currentPlanHash);

  // Determine completedAt from last wave if top-level completedAt is absent
  let completedAt = execData.completedAt;
  if (!completedAt && Array.isArray(execData.waves) && execData.waves.length > 0) {
    const lastWave = execData.waves[execData.waves.length - 1];
    completedAt = lastWave.completedAt;
  }

  const runRecord = {
    runFile: runRelativePath,
    branch: execData.branch || 'unknown',
    planHash: execData.planHash || '',
    driftStatus: isPristine ? 'pristine' : 'drifted',
    ...(execData.startedAt ? { startedAt: execData.startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(execData.quality ? { quality: execData.quality } : {})
  };

  plan.executionRuns.push(runRecord);

  // Flatten tasks from execution waves
  const execTasks = [];
  if (Array.isArray(execData.waves)) {
    for (const wave of execData.waves) {
      if (Array.isArray(wave.tasks)) {
        execTasks.push(...wave.tasks);
      }
    }
  }

  // Match tasks in plan by id or title
  for (const execTask of execTasks) {
    const execTaskId = String(execTask.id).trim();
    const execTaskName = execTask.name || '';

    const planTask = plan.tasks.find(pt => {
      if (String(pt.id).trim() === execTaskId) return true;
      if (execTaskName && (pt.title.includes(execTaskName) || execTaskName.includes(pt.title))) return true;
      return false;
    });

    if (planTask) {
      if (execTask.status === 'completed') {
        planTask.status = 'done';
      } else if (execTask.status === 'failed') {
        planTask.status = 'blocked';
      } else if (execTask.status === 'in_progress') {
        planTask.status = 'in_progress';
      }

      // Merge filesChanged
      if (Array.isArray(execTask.filesChanged)) {
        for (const f of execTask.filesChanged) {
          if (!planTask.files.modify.includes(f) && !planTask.files.create.includes(f) && !planTask.files.test.includes(f)) {
            planTask.files.modify.push(f);
          }
        }
      }

      // Add statusEvidence
      planTask.statusEvidence = {
        ...planTask.statusEvidence,
        executionLog: path.basename(runRelativePath)
      };
      if (execData.commit && !planTask.statusEvidence.commit) {
        planTask.statusEvidence.commit = execData.commit;
      }
      if (execData.pr && !planTask.statusEvidence.pr) {
        planTask.statusEvidence.pr = execData.pr;
      }
    }
  }
}

/**
 * Reconcile wave statuses and plan status after execution runs applied.
 * @param {object} plan
 */
function reconcilePlanStatuses(plan) {
  for (const wave of plan.waves) {
    const waveTasks = plan.tasks.filter(t => t.waveId === wave.id);
    if (waveTasks.length === 0) continue;

    const doneCount = waveTasks.filter(t => t.status === 'done').length;
    const progCount = waveTasks.filter(t => t.status === 'in_progress').length;
    const blockedCount = waveTasks.filter(t => t.status === 'blocked').length;

    if (doneCount === waveTasks.length) {
      wave.status = 'completed';
    } else if (progCount > 0 || doneCount > 0) {
      wave.status = 'in_progress';
    } else if (blockedCount > 0) {
      wave.status = 'blocked';
    } else {
      wave.status = 'planned';
    }
  }

  if (plan.filePath.includes('/archived/')) {
    plan.status = 'archived';
  } else if (plan.tasks.length > 0) {
    const doneCount = plan.tasks.filter(t => t.status === 'done').length;
    const progCount = plan.tasks.filter(t => t.status === 'in_progress').length;
    const blockedCount = plan.tasks.filter(t => t.status === 'blocked').length;

    if (doneCount === plan.tasks.length) {
      plan.status = 'done';
    } else if (doneCount > 0 || progCount > 0) {
      plan.status = 'in_progress';
    } else if (blockedCount > 0) {
      plan.status = 'blocked';
    } else {
      plan.status = 'proposed';
    }
  }
}

/**
 * Bidirectional Blocker Binding between TODO notes and Tasks.
 * Computes:
 * - Task.blockedByTodoIds
 * - TodoItem.blockedTaskGlobalIds
 * - Task.isReadyToDispatch
 *
 * @param {Array<object>} plans
 * @param {Array<object>} todos
 */
function bindTodosAndBlockers(plans, todos) {
  const taskMapByGlobalId = new Map();
  const allTasks = [];

  for (const plan of plans) {
    for (const task of plan.tasks) {
      task.blockedByTodoIds = task.blockedByTodoIds || [];
      taskMapByGlobalId.set(task.globalId, task);
      allTasks.push(task);
    }
  }

  const todoMapById = new Map();
  for (const todo of todos) {
    todo.blockedTaskGlobalIds = todo.blockedTaskGlobalIds || [];
    todoMapById.set(todo.id, todo);
  }

  // Bind TODOs to matching Tasks
  for (const todo of todos) {
    // Only active TODOs act as blockers
    const isActive = ['open', 'in_progress', 'blocked'].includes(todo.status);
    if (!isActive) continue;

    const blocksText = (todo.blocks || '').toLowerCase();
    const relatedText = (todo.relatedPlan || '').toLowerCase();

    for (const plan of plans) {
      const planMatches =
        relatedText.includes(plan.id.toLowerCase()) ||
        relatedText.includes(path.basename(plan.filePath, path.extname(plan.filePath)).toLowerCase()) ||
        blocksText.includes(plan.id.toLowerCase());

      if (planMatches) {
        for (const task of plan.tasks) {
          // Check if specific task ID or title is referenced in blocks text
          const taskIdLower = task.id.toLowerCase();
          const taskSlugLower = task.slug ? task.slug.toLowerCase() : '';
          const isTaskBlocked =
            blocksText.includes(taskIdLower) ||
            (taskSlugLower && blocksText.includes(taskSlugLower)) ||
            (task.title && blocksText.includes(task.title.toLowerCase().slice(0, 20)));

          if (isTaskBlocked) {
            if (!task.blockedByTodoIds.includes(todo.id)) {
              task.blockedByTodoIds.push(todo.id);
            }
            if (!todo.blockedTaskGlobalIds.includes(task.globalId)) {
              todo.blockedTaskGlobalIds.push(task.globalId);
            }
            if (todo.priority === 'P0' && task.status !== 'done') {
              task.status = 'blocked';
            }
          }
        }
      }
    }
  }

  // Compute Task.isReadyToDispatch:
  // task.status === 'todo' AND all dependsOn tasks are 'done' AND no active blocking P0 TODOs
  for (const task of allTasks) {
    if (task.status !== 'todo') {
      task.isReadyToDispatch = false;
      continue;
    }

    // Check upstream dependencies
    let depsAllDone = true;
    for (const depId of task.dependsOn) {
      const depTask = taskMapByGlobalId.get(depId);
      if (!depTask || depTask.status !== 'done') {
        depsAllDone = false;
        break;
      }
    }

    // Check blocking P0 TODOs
    let hasBlockingP0 = false;
    for (const todoId of task.blockedByTodoIds) {
      const todo = todoMapById.get(todoId);
      if (todo && ['open', 'in_progress', 'blocked'].includes(todo.status) && todo.priority === 'P0') {
        hasBlockingP0 = true;
        break;
      }
    }

    task.isReadyToDispatch = Boolean(depsAllDone && !hasBlockingP0);
  }
}

/**
 * Reconcile an entire project:
 * 1. Compute plan hashes.
 * 2. Find and apply execution runs.
 * 3. Update plan/wave statuses.
 * 4. Bind TODO blockers and compute isReadyToDispatch.
 *
 * @param {object} project
 * @returns {object} Updated project
 */
function reconcileProject(project) {
  const repoPath = project.repoPath;
  const plans = project.plans || [];
  const todos = project.todos || [];

  // 1. Compute current plan hashes
  const planHashMap = new Map();
  for (const plan of plans) {
    const fullPlanPath = path.isAbsolute(plan.filePath)
      ? plan.filePath
      : path.join(repoPath, plan.filePath);

    if (fs.existsSync(fullPlanPath)) {
      try {
        const hash = computePlanHash(fullPlanPath);
        planHashMap.set(plan.filePath, hash);
      } catch {
        // file unreadable
      }
    }
  }

  // 2. Load and match execution runs
  const executionRuns = loadExecutionRuns(repoPath);
  for (const { relativeFile, data } of executionRuns) {
    const matchedPlan = matchExecutionToPlan(data, plans, repoPath, planHashMap);
    if (matchedPlan) {
      const currentHash = planHashMap.get(matchedPlan.filePath);
      applyExecutionToPlan(matchedPlan, data, relativeFile, currentHash);
    }
  }

  // 3. Reconcile statuses
  for (const plan of plans) {
    reconcilePlanStatuses(plan);
  }

  // 4. Blocker binding and dispatch readiness
  bindTodosAndBlockers(plans, todos);

  return project;
}

module.exports = {
  reconcileProject,
  matchExecutionToPlan,
  applyExecutionToPlan,
  bindTodosAndBlockers,
  normalizePath
};
