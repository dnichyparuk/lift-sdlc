'use strict';

/**
 * plan-static-critique.js
 * Deterministic Step 3 static critique for plan files covering:
 *   - G3:  DAG dependency cycles (reuses checkPF4)
 *   - G4:  Unsequenced shared Modify: file paths lacking transitive Depends on: ordering
 *   - G10: Modify: file paths missing on disk and not created by an earlier task
 *   - G12: Missing dependency targets (reuses checkPF4)
 *
 * Zero external dependencies — Node.js built-ins + repo modules only.
 */

const fs = require('node:fs');
const path = require('node:path');

const { extractTasks, extractField, checkPF4 } = require(
  path.join(__dirname, '..', 'ci', 'validate-plan-format')
);
const { markFences } = require(path.join(__dirname, 'plan-checkboxes'));

const STATIC_GATE_IDS = Object.freeze(['G3', 'G4', 'G10', 'G12']);

/**
 * Normalize a relative or POSIX-like file path from a plan's Files: section so
 * `./src/a.js` and `src//a.js` compare identically across tasks.
 * @param {string} rawPath
 * @returns {string}
 */
function normalizePlanPath(rawPath) {
  const cleaned = String(rawPath || '')
    .trim()
    .replace(/^[`'"*]+|[`'"*]+$/g, '')
    .replace(/\\/g, '/');
  if (!cleaned) return '';
  return path.posix.normalize(cleaned);
}

/**
 * Extract deduplicated Create: and Modify: file paths from a task body,
 * ignoring fenced code blocks.
 * @param {string} taskBody
 * @returns {{ create: string[], modify: string[] }}
 */
function extractTaskFiles(taskBody) {
  const create = [];
  const modify = [];
  const seenCreate = new Set();
  const seenModify = new Set();

  for (const { text, fenced } of markFences(taskBody)) {
    if (fenced) continue;
    const match = text.match(/^\s*[-*]\s+(Create|Modify):\s*(?:`([^`]+)`|([^\s,;]+))/i);
    if (!match) continue;

    const kind = match[1].toLowerCase();
    const rawTarget = match[2] || match[3];
    const normalized = normalizePlanPath(rawTarget);
    if (!normalized) continue;

    if (kind === 'create' && !seenCreate.has(normalized)) {
      seenCreate.add(normalized);
      create.push(normalized);
    } else if (kind === 'modify' && !seenModify.has(normalized)) {
      seenModify.add(normalized);
      modify.push(normalized);
    }
  }

  return { create, modify };
}

/**
 * Build an adjacency map (task number -> direct dependency task numbers).
 * @param {Array<{ number: number, title: string, body: string }>} tasks
 * @returns {Map<number, number[]>}
 */
function buildDepGraph(tasks) {
  const depGraph = new Map();
  for (const task of tasks) {
    const dependsOn = extractField(task.body, 'Depends on');
    if (!dependsOn || dependsOn.trim().toLowerCase() === 'none') {
      depGraph.set(task.number, []);
      continue;
    }

    const refs = [];
    const refRe = /Task\s+(\d+)/gi;
    let match;
    while ((match = refRe.exec(dependsOn)) !== null) {
      refs.push(parseInt(match[1], 10));
    }
    depGraph.set(task.number, refs);
  }
  return depGraph;
}

/**
 * Compute all transitive dependency task numbers for `startNum` (cycle-safe).
 * Excludes `startNum` itself even when a self- or multi-node cycle exists.
 * @param {number} startNum
 * @param {Map<number, number[]>} depGraph
 * @returns {Set<number>}
 */
function getTransitiveDeps(startNum, depGraph) {
  const ancestors = new Set();
  const queue = [...(depGraph.get(startNum) || [])];

  while (queue.length > 0) {
    const dep = queue.shift();
    if (dep === startNum || ancestors.has(dep)) continue;
    ancestors.add(dep);
    for (const parent of depGraph.get(dep) || []) {
      if (parent !== startNum && !ancestors.has(parent)) {
        queue.push(parent);
      }
    }
  }

  return ancestors;
}

/**
 * Classify checkPF4 output into G3 (cycles) and G12 (missing targets) issues.
 * @param {Array<{ number: number, title: string, body: string }>} tasks
 * @returns {Array<object>}
 */
function evaluatePF4Gates(tasks) {
  const issues = [];
  const pf4 = checkPF4(tasks);
  if (pf4.status !== 'fail') return issues;

  for (const msg of pf4.message.split('; ').filter(Boolean)) {
    if (/depends on nonexistent/i.test(msg)) {
      const m = msg.match(/^(Task\s+\d+)/i);
      issues.push({
        gateId: 'G12',
        severity: 'error',
        taskRef: m ? m[1] : null,
        message: msg,
        blocking: true,
      });
    } else {
      const m = msg.match(/(Task\s+\d+)/i);
      issues.push({
        gateId: 'G3',
        severity: 'error',
        taskRef: m ? m[1] : null,
        message: msg,
        blocking: true,
      });
    }
  }

  return issues;
}

/**
 * G4: detect tasks sharing a Modify: file path without an explicit transitive
 * Depends on: ordering between them.
 * @param {Array<{ number: number, files: { create: string[], modify: string[] } }>} parsedTasks
 * @param {Map<number, Set<number>>} ancestorsByTask
 * @returns {Array<object>}
 */
function evaluateG4(parsedTasks, ancestorsByTask) {
  const issues = [];
  const tasksByModifyPath = new Map();

  for (const task of parsedTasks) {
    for (const filePath of task.files.modify) {
      if (!tasksByModifyPath.has(filePath)) {
        tasksByModifyPath.set(filePath, []);
      }
      tasksByModifyPath.get(filePath).push(task.number);
    }
  }

  for (const [filePath, taskNums] of tasksByModifyPath.entries()) {
    if (taskNums.length < 2) continue;
    const sorted = [...new Set(taskNums)].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        const aDependsOnB = ancestorsByTask.get(a)?.has(b);
        const bDependsOnA = ancestorsByTask.get(b)?.has(a);
        if (!aDependsOnB && !bDependsOnA) {
          issues.push({
            gateId: 'G4',
            severity: 'error',
            taskRef: `Task ${b}`,
            message: `File '${filePath}' listed as Modify: in both Task ${a} and Task ${b} without explicit Depends on: ordering`,
            blocking: true,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * G10: verify every Modify: file path exists on disk OR is listed under Create:
 * in an explicit transitive dependency task (Depends on:).
 * @param {Array<{ number: number, files: { create: string[], modify: string[] } }>} parsedTasks
 * @param {Map<number, Set<number>>} ancestorsByTask
 * @param {string} resolvedRoot
 * @returns {Array<object>}
 */
function evaluateG10(parsedTasks, ancestorsByTask, resolvedRoot) {
  const issues = [];
  const createdByPath = new Map();

  for (const task of parsedTasks) {
    for (const filePath of task.files.create) {
      if (!createdByPath.has(filePath)) {
        createdByPath.set(filePath, new Set());
      }
      createdByPath.get(filePath).add(task.number);
    }
  }

  for (const task of parsedTasks) {
    const ancestors = ancestorsByTask.get(task.number) || new Set();
    for (const filePath of task.files.modify) {
      const absTarget = path.resolve(resolvedRoot, filePath);
      if (fs.existsSync(absTarget)) {
        continue;
      }

      const creators = createdByPath.get(filePath);
      if (creators && creators.size > 0) {
        const precededByCreator = [...creators].some(
          creatorNum => creatorNum !== task.number && ancestors.has(creatorNum)
        );
        if (precededByCreator) {
          continue;
        }
        const sortedCreators = [...creators].sort((a, b) => a - b);
        const otherCreators = sortedCreators.filter(c => c !== task.number);
        const message = otherCreators.length > 0
          ? `File '${filePath}' listed as Modify: in Task ${task.number} is created by Task ${otherCreators.join(', Task ')} which does not precede Task ${task.number} via explicit Depends on: Task ${otherCreators.join(' / Task ')}`
          : `File '${filePath}' listed as Modify: in Task ${task.number} is created by Task ${sortedCreators.join(', Task ')} which does not precede Task ${task.number}`;
        issues.push({
          gateId: 'G10',
          severity: 'error',
          taskRef: `Task ${task.number}`,
          message,
          blocking: true,
        });
        continue;
      }

      issues.push({
        gateId: 'G10',
        severity: 'error',
        taskRef: `Task ${task.number}`,
        message: `File '${filePath}' listed as Modify: in Task ${task.number} does not exist on disk and is not created by an earlier task`,
        blocking: true,
      });
    }
  }

  return issues;
}

/**
 * Run deterministic static critique (G3, G4, G10, G12) on a plan file.
 *
 * @param {string} planPath     Path to the plan markdown file
 * @param {string} [projectRoot=process.cwd()]  Repository/project root for G10 file existence checks
 * @returns {{ gateIds: string[], issues: Array<object>, passes: string[], laneStatus: 'ok' }}
 */
function runStaticCritique(planPath, projectRoot = process.cwd()) {
  if (!planPath || typeof planPath !== 'string') {
    throw new Error('planPath is required');
  }

  const resolvedPlanPath = path.resolve(planPath);
  const resolvedRoot = projectRoot ? path.resolve(projectRoot) : process.cwd();
  const content = fs.readFileSync(resolvedPlanPath, 'utf8');

  const tasks = extractTasks(content);
  const depGraph = buildDepGraph(tasks);
  const ancestorsByTask = new Map();
  for (const task of tasks) {
    ancestorsByTask.set(task.number, getTransitiveDeps(task.number, depGraph));
  }

  const parsedTasks = tasks.map(task => ({
    number: task.number,
    title: task.title,
    files: extractTaskFiles(task.body),
  }));

  const issues = [
    ...evaluatePF4Gates(tasks),
    ...evaluateG4(parsedTasks, ancestorsByTask),
    ...evaluateG10(parsedTasks, ancestorsByTask, resolvedRoot),
  ];

  const failedGates = new Set(issues.map(i => i.gateId));
  const passes = STATIC_GATE_IDS.filter(id => !failedGates.has(id));

  return {
    gateIds: [...STATIC_GATE_IDS],
    issues,
    passes,
    laneStatus: 'ok',
  };
}

module.exports = {
  STATIC_GATE_IDS,
  normalizePlanPath,
  extractTaskFiles,
  buildDepGraph,
  getTransitiveDeps,
  runStaticCritique,
};
