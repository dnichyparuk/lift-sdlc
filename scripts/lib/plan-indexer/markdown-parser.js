'use strict';

/**
 * markdown-parser.js
 * Deterministic parser for plan markdown and TODO markdown files.
 * Zero-LLM, high-performance extraction of delivery plans, waves, tasks, and notes.
 */

const path = require('node:path');

/**
 * Helper to slugify task or plan identifiers for DOM and URL safety.
 * e.g. "Task 0.1" -> "task-0-1", "W0-T01" -> "w0-t01"
 * @param {string} str
 * @returns {string}
 */
function slugify(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Helper to clean Markdown formatting (backticks, bold, links) from a title
 * @param {string} text
 * @returns {string}
 */
function cleanMarkdownText(text) {
  if (!text) return '';
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) -> text
    .replace(/[`*_~]/g, '')                   // formatting chars
    .trim();
}

/**
 * Strip parenthetical annotations: e.g. "Medium (step 3...)" -> "Medium"
 * @param {string} str
 * @returns {string}
 */
function stripParenthetical(str) {
  if (!str) return '';
  return str.replace(/\s*\([^)]*\)/g, '').trim();
}

/**
 * Normalize complexity to Trivial | Standard | Complex
 * @param {string} raw
 * @returns {"Trivial" | "Standard" | "Complex"}
 */
function normalizeComplexity(raw) {
  const cleaned = stripParenthetical(raw).toLowerCase();
  if (cleaned.includes('triv') || cleaned === 'low') return 'Trivial';
  if (cleaned.includes('comp') || cleaned === 'high') return 'Complex';
  return 'Standard';
}

/**
 * Normalize risk to Low | Medium | High
 * @param {string} raw
 * @returns {"Low" | "Medium" | "High"}
 */
function normalizeRisk(raw) {
  const cleaned = stripParenthetical(raw).toLowerCase();
  if (cleaned.includes('high') || cleaned.includes('crit')) return 'High';
  if (cleaned.includes('med')) return 'Medium';
  return 'Low';
}

/**
 * Normalize task status
 * @param {string} raw
 * @param {Array<{checked: boolean}>} acList
 * @returns {"todo" | "in_progress" | "done" | "partly" | "blocked" | "skipped"}
 */
function determineTaskStatus(raw, acList = []) {
  if (raw) {
    const cleaned = stripParenthetical(raw).toLowerCase();
    if (cleaned.includes('done') || cleaned.includes('complete') || cleaned.includes('passed')) return 'done';
    if (cleaned.includes('prog') || cleaned.includes('wip') || cleaned.includes('active')) return 'in_progress';
    if (cleaned.includes('part')) return 'partly';
    if (cleaned.includes('block')) return 'blocked';
    if (cleaned.includes('skip') || cleaned.includes('wont') || cleaned.includes('deferred')) return 'skipped';
    if (cleaned.includes('todo') || cleaned.includes('plan')) return 'todo';
  }

  if (acList.length > 0) {
    const checkedCount = acList.filter(a => a.checked).length;
    if (checkedCount === acList.length) return 'done';
    if (checkedCount > 0) return 'in_progress';
    return 'todo';
  }

  return 'todo';
}

/**
 * Parse a plan markdown file content into structured Plan object.
 *
 * @param {string} markdownContent
 * @param {object} options
 * @param {string} options.filePath - Relative path to the markdown file from project root
 * @param {string} [options.projectId='default'] - Project identifier
 * @param {string} [options.planId] - Optional explicit plan ID
 * @returns {import('../../../schemas/delivery-graph.schema.json').Plan}
 */
function parsePlanMarkdown(markdownContent, options = {}) {
  const {
    filePath = 'docs/plans/plan.md',
    projectId = 'project',
  } = options;

  const planId = options.planId || slugify(path.basename(filePath, path.extname(filePath)));
  const lines = markdownContent.split(/\r?\n/);

  let title = path.basename(filePath, path.extname(filePath));
  let goal = '';
  let architectureSummary = '';
  let verificationCommand = '';
  let sourcePlanPath = '';
  let version = '';

  const waves = [];
  const tasks = [];

  let inCodeBlock = false;
  let currentWave = null;
  let currentTask = null;
  let currentTaskLines = [];
  let headerFinished = false;
  let hasExplicitWaves = false;
  let currentHeaderField = null;

  // Wave identification helper
  function ensureDefaultWave() {
    if (!currentWave) {
      currentWave = {
        id: 'wave-1',
        title: 'Wave 1: Execution',
        order: 1,
        status: 'planned',
        dependsOn: []
      };
      waves.push(currentWave);
    }
  }

  function finalizeCurrentTask() {
    if (!currentTask) return;
    currentTask.markdownSource = currentTaskLines.join('\n').trim();
    // Resolve status if not explicitly set
    if (!currentTask.statusExplicit) {
      currentTask.status = determineTaskStatus(null, currentTask.acceptanceCriteria);
    }
    delete currentTask.statusExplicit;
    tasks.push(currentTask);
    currentTask = null;
    currentTaskLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 1. Code fence tracking
    if (/^\s*(?:```|~~~)/.test(line)) {
      inCodeBlock = !inCodeBlock;
      if (currentTask) currentTaskLines.push(line);
      continue;
    }

    if (inCodeBlock) {
      if (currentTask) currentTaskLines.push(line);
      continue;
    }

    // 2. Parse Top H1 Title
    const h1Match = line.match(/^#\s+(.+)$/);
    if (h1Match && !headerFinished && !currentTask) {
      title = cleanMarkdownText(h1Match[1]);
      // Check if version is embedded in title (e.g. "Plan v2", "(v2)")
      const titleVerMatch = title.match(/\b(?:v|version\s*)([0-9]+(?:\.[0-9]+)?)\b/i);
      if (titleVerMatch && !version) {
        version = `v${titleVerMatch[1]}`;
      }
      continue;
    }

    // 3. Document Header Metadata Fields (before any task or wave starts)
    if (!currentTask && !headerFinished) {
      const goalMatch = line.match(/\*\*Goal:\*\*\s*(.+)/i);
      if (goalMatch) {
        goal = cleanMarkdownText(goalMatch[1]);
        currentHeaderField = 'goal';
        continue;
      }

      const archMatch = line.match(/\*\*Architecture:\*\*\s*(.+)/i);
      if (archMatch) {
        architectureSummary = cleanMarkdownText(archMatch[1]);
        currentHeaderField = 'arch';
        continue;
      }

      const verifMatch = line.match(/\*\*Verification:\*\*\s*(.+)/i);
      if (verifMatch) {
        verificationCommand = cleanMarkdownText(verifMatch[1]);
        currentHeaderField = 'verif';
        continue;
      }

      const srcMatch = line.match(/\*\*Source:\*\*\s*(.+)/i);
      if (srcMatch) {
        sourcePlanPath = cleanMarkdownText(srcMatch[1]);
        currentHeaderField = 'source';
        continue;
      }

      const verMatch = line.match(/(?:\*\*Version:\*\*|>\s*\*\*Plan version:\*\*)\s*([^\s,;]+)/i);
      if (verMatch) {
        version = verMatch[1].replace(/[`*]/g, '').trim();
        currentHeaderField = 'version';
        continue;
      }

      if (/^\s*\*\*[A-Za-z0-9_ -]+:\*\*/.test(line) || /^\s*---/.test(line)) {
        currentHeaderField = null;
      } else if (currentHeaderField && trimmed) {
        const cleanChunk = cleanMarkdownText(trimmed);
        if (currentHeaderField === 'source') {
          sourcePlanPath = sourcePlanPath ? `${sourcePlanPath} ${cleanChunk}` : cleanChunk;
        } else if (currentHeaderField === 'goal') {
          goal = goal ? `${goal} ${cleanChunk}` : cleanChunk;
        } else if (currentHeaderField === 'arch') {
          architectureSummary = architectureSummary ? `${architectureSummary} ${cleanChunk}` : cleanChunk;
        }
      }
    }

    // 4. Wave Boundary Detection
    // Matches:
    // "### Wave 0: ...", "## Wave B: ...", "### Wave 1", "## Wave 2"
    // "### Phase 0 — ...", "### Stage (a) — ...", "## Additional Wave (...)"
    // "### P1b.W0 — Parity instruments", "**Wave A — shared infrastructure**"
    const waveHeaderMatch =
      line.match(/^(?:##|###)\s+(?:(?:Wave|Phase|Stage|Part)\s+([A-Za-z0-9_.-]+)(?:(?::|\s*[—–-])\s*(.*))?|(?:[A-Za-z0-9_.-]+\.)(W[A-Za-z0-9_.-]+)\s*[—–-]\s*(.*)|Additional Wave(?:\s*\(([^)]+)\))?(?:(?::|\s*[—–-])\s*(.*))?)$/i) ||
      line.match(/^\*\*(?:Wave|Phase)\s+([A-Za-z0-9_.-]+)(?:(?::|\s*[—–-])\s*([^*]+))?\*\*$/i);

    if (waveHeaderMatch) {
      if (currentTask) {
        finalizeCurrentTask();
      }
      hasExplicitWaves = true;
      headerFinished = true;
      const waveTag = waveHeaderMatch[1] || waveHeaderMatch[3] || waveHeaderMatch[5] || 'additional';
      const waveDesc = (waveHeaderMatch[2] || waveHeaderMatch[4] || waveHeaderMatch[6] || '').trim();
      const waveId = `wave-${slugify(waveTag)}`;

      // Check if wave already recorded
      let existingWave = waves.find(w => w.id === waveId);
      if (!existingWave) {
        const order = waves.length + 1;
        const prevWave = waves.length > 0 ? waves[waves.length - 1] : null;
        existingWave = {
          id: waveId,
          title: waveDesc ? `Wave ${waveTag}: ${waveDesc}` : `Wave ${waveTag}`,
          order,
          status: 'planned',
          dependsOn: prevWave ? [prevWave.id] : []
        };
        waves.push(existingWave);
      }
      currentWave = existingWave;
      continue;
    }

    // 5. Task Boundary Detection
    // Matches 4 syntax patterns:
    // a) Standard plan-sdlc: `### Task 1: ...` or `### Task PLR-10a: ...`
    // b) trade-robot-alpha: `#### Task W0-T01: ...` or `#### Task T0: ...`
    // c) lift-fixed-price review fixes: `### X1 — ...` or `### W1 — ...`
    // d) List items or subtasks: `* **Task 0.1: ...**` or `### Task 0.1: ...`
    let taskHeaderMatch = null;
    let matchedId = null;
    let matchedTitle = null;

    // Pattern a & b & d: ### Task <ID>: <Title> or #### Task <ID>: <Title>
    const taskStdMatch = line.match(/^(?:###|####)\s+Task\s+([A-Za-z0-9_.-]+)(?::\s*|\s+[—–-]\s*)(.+)$/i);
    if (taskStdMatch) {
      taskHeaderMatch = true;
      matchedId = taskStdMatch[1].trim();
      matchedTitle = cleanMarkdownText(taskStdMatch[2]);
    }

    // Pattern c: ### X1 — Title or ### W1 — Title
    if (!taskHeaderMatch) {
      const reviewFixMatch = line.match(/^###\s+([XW][0-9]+)\s+[—–-]\s*(.+)$/i);
      if (reviewFixMatch) {
        taskHeaderMatch = true;
        matchedId = reviewFixMatch[1].trim();
        matchedTitle = cleanMarkdownText(reviewFixMatch[2]);
      }
    }

    // Pattern d (list item format): * **Task <ID>: <Title>**
    if (!taskHeaderMatch) {
      const listTaskMatch = line.match(/^\*\s+(?:\[([ xX])\]\s+)?\*\*Task\s+([A-Za-z0-9_.-]+):\s*([^*]+)\*\*/i);
      if (listTaskMatch) {
        taskHeaderMatch = true;
        matchedId = listTaskMatch[2].trim();
        matchedTitle = cleanMarkdownText(listTaskMatch[3]);
      }
    }

    // Pattern e (other code-fix items like ### E-4 — ENGINE_VERSION Export):
    if (!taskHeaderMatch) {
      const altCodeMatch = line.match(/^###\s+([A-Z0-9]+-[0-9]+)\s+[—–-]\s*(.+)$/i);
      if (altCodeMatch) {
        taskHeaderMatch = true;
        matchedId = altCodeMatch[1].trim();
        matchedTitle = cleanMarkdownText(altCodeMatch[2]);
      }
    }

    if (taskHeaderMatch && matchedId) {
      headerFinished = true;
      finalizeCurrentTask();
      ensureDefaultWave();

      const taskLocalId = matchedId;
      const taskSlug = slugify(taskLocalId);
      const globalId = `urn:sdlc:${projectId}:${planId}:${taskLocalId}`;

      currentTask = {
        id: taskLocalId,
        slug: taskSlug,
        globalId,
        title: matchedTitle || taskLocalId,
        waveId: currentWave.id,
        complexity: 'Standard',
        risk: 'Low',
        status: 'todo',
        statusEvidence: {},
        dependsOn: [],
        files: {
          create: [],
          modify: [],
          delete: [],
          test: []
        },
        acceptanceCriteria: [],
        markdownAnchor: line.trim(),
        markdownSource: '',
        statusExplicit: false,
        blockedByTodoIds: []
      };

      currentTaskLines = [line];
      continue;
    }

    // If inside a task, accumulate lines and extract metadata
    if (currentTask) {
      currentTaskLines.push(line);

      // Explicit Status
      const statusMatch = line.match(/\*\*Status:\*\*\s*(.+)/i);
      if (statusMatch) {
        currentTask.status = determineTaskStatus(statusMatch[1]);
        currentTask.statusExplicit = true;
      }

      // Metadata on one line or middot-separated:
      // - **Complexity:** Standard · **Risk:** Low · **Depends on:** none · **Verify:** tests
      // or standalone lines
      const compMatch = line.match(/\*\*Complexity:\*\*\s*([^·\n\r]+)/i);
      if (compMatch) {
        currentTask.complexity = normalizeComplexity(compMatch[1]);
      }

      const riskMatch = line.match(/\*\*Risk:\*\*\s*([^·\n\r]+)/i);
      if (riskMatch) {
        currentTask.risk = normalizeRisk(riskMatch[1]);
      }

      const depMatch = line.match(/\*\*Depends on:\*\*\s*([^·\n\r]+)/i);
      if (depMatch) {
        const rawDeps = depMatch[1].trim();
        const parts = rawDeps.split(/[,;&]|\band\b/i);
        const resolvedDeps = [];
        for (let p of parts) {
          p = p.trim().replace(/^Tasks?\s+/i, '').replace(/[`*]/g, '').trim();
          if (p && !/^none$|^—$|^-$|^n\/a$/i.test(p)) {
            // Strip parentheticals if any
            p = stripParenthetical(p);
            if (p) resolvedDeps.push(p);
          }
        }
        currentTask.dependsOn = resolvedDeps;
      }

      // Acceptance Criteria: - [x] or - [ ]
      const acMatch = line.match(/^-\s+\[([ xX])\]\s*(.+)$/);
      if (acMatch) {
        currentTask.acceptanceCriteria.push({
          text: cleanMarkdownText(acMatch[2]),
          checked: acMatch[1].toLowerCase() === 'x'
        });
      }

      // Files extraction
      // 1. Bullet items: - Create: <path> or - Modify: <path> or - Test: <path> or - Delete: <path>
      const fileBulletMatch = line.match(/^-\s+(Create|Modify|Delete|Test):\s*`?([^`\s,]+)`?/i);
      if (fileBulletMatch) {
        const op = fileBulletMatch[1].toLowerCase();
        const filePathTarget = fileBulletMatch[2].replace(/[`*]/g, '').trim();
        if (op === 'create') currentTask.files.create.push(filePathTarget);
        else if (op === 'modify') currentTask.files.modify.push(filePathTarget);
        else if (op === 'delete') currentTask.files.delete.push(filePathTarget);
        else if (op === 'test') currentTask.files.test.push(filePathTarget);
      }

      // 2. Files to modify / Files bullet items: - `path` *(new)*
      const simpleFileBullet = line.match(/^-\s+`([^`]+)`(?:\s*\*\((new)\)\*)?/i);
      if (simpleFileBullet) {
        const p = simpleFileBullet[1].trim();
        const isNew = Boolean(simpleFileBullet[2]);
        if (isNew) {
          if (!currentTask.files.create.includes(p)) currentTask.files.create.push(p);
        } else if (p.includes('.test.') || p.includes('test_') || p.includes('/tests/')) {
          if (!currentTask.files.test.includes(p)) currentTask.files.test.push(p);
        } else {
          if (!currentTask.files.modify.includes(p)) currentTask.files.modify.push(p);
        }
      }
    }
  }

  // End of file: finalize remaining task
  finalizeCurrentTask();
  ensureDefaultWave();

  // Normalize dependsOn: map local task IDs in dependsOn to canonical URNs
  // e.g. "T0" -> "urn:sdlc:${projectId}:${planId}:T0"
  for (const t of tasks) {
    t.dependsOn = t.dependsOn.map(dep => {
      if (dep.startsWith('urn:sdlc:')) return dep;
      return `urn:sdlc:${projectId}:${planId}:${dep}`;
    });
  }

  // Derive execution waves from task dependency DAG if no explicit waves were defined
  // or if only a single default wave exists across multiple interdependent tasks
  const wavesWithTasks = waves.filter(w => tasks.some(t => t.waveId === w.id));
  if (!hasExplicitWaves || wavesWithTasks.length <= 1) {
    if (tasks.length > 1) {
      const taskMap = new Map(tasks.map(t => [t.id, t]));
      const taskLevels = new Map();

      function getLevel(id, visited = new Set()) {
        if (taskLevels.has(id)) return taskLevels.get(id);
        if (visited.has(id)) return 1;
        visited.add(id);
        const t = taskMap.get(id);
        if (!t || !t.dependsOn || t.dependsOn.length === 0) {
          taskLevels.set(id, 1);
          return 1;
        }
        let maxDep = 0;
        for (const dep of t.dependsOn) {
          const localDepId = dep.startsWith('urn:sdlc:') ? dep.split(':').pop() : dep;
          if (taskMap.has(localDepId)) {
            maxDep = Math.max(maxDep, getLevel(localDepId, new Set(visited)));
          }
        }
        const lvl = maxDep + 1;
        taskLevels.set(id, lvl);
        return lvl;
      }

      tasks.forEach(t => getLevel(t.id));
      const maxLevel = Math.max(...Array.from(taskLevels.values()), 1);

      if (maxLevel > 1) {
        waves.length = 0;
        for (let l = 1; l <= maxLevel; l++) {
          const waveId = `wave-${l}`;
          const prevWave = l > 1 ? `wave-${l - 1}` : null;
          waves.push({
            id: waveId,
            title: `Wave ${l}: Execution Stage ${l}`,
            order: l,
            status: 'planned',
            dependsOn: prevWave ? [prevWave] : []
          });
        }
        for (const t of tasks) {
          const lvl = taskLevels.get(t.id) || 1;
          t.waveId = `wave-${lvl}`;
        }
      }
    }
  }

  // Plan status computation
  let planStatus = 'proposed';
  if (filePath.includes('/archived/')) {
    planStatus = 'archived';
  } else if (tasks.length > 0) {
    const doneCount = tasks.filter(t => t.status === 'done').length;
    const progCount = tasks.filter(t => t.status === 'in_progress').length;
    const blockedCount = tasks.filter(t => t.status === 'blocked').length;

    if (doneCount === tasks.length) {
      planStatus = 'done';
    } else if (doneCount > 0 || progCount > 0) {
      planStatus = 'in_progress';
    } else if (blockedCount > 0) {
      planStatus = 'blocked';
    } else {
      planStatus = 'proposed';
    }
  }

  // Wave status computation based on tasks
  for (const wave of waves) {
    const waveTasks = tasks.filter(t => t.waveId === wave.id);
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

  return {
    id: planId,
    title,
    filePath,
    status: planStatus,
    ...(version ? { version } : {}),
    ...(goal ? { goal } : {}),
    ...(architectureSummary ? { architectureSummary } : {}),
    ...(verificationCommand ? { verificationCommand } : {}),
    ...(sourcePlanPath ? { sourcePlanPath } : {}),
    executionRuns: [],
    waves,
    tasks
  };
}

/**
 * Parse a TODO markdown file into a structured TodoItem object.
 *
 * @param {string} markdownContent
 * @param {object} options
 * @param {string} options.filePath - Relative path from project root
 * @returns {import('../../../schemas/delivery-graph.schema.json').TodoItem}
 */
function parseTodoMarkdown(markdownContent, options = {}) {
  const { filePath = 'docs/TODO/todo.md' } = options;
  const todoId = slugify(path.basename(filePath, path.extname(filePath)));
  const lines = markdownContent.split(/\r?\n/);

  let title = todoId;
  let status = 'open';
  let priority = 'P1';
  let blocks = '';
  let relatedPlan = '';
  let trigger = '';
  let area = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // H1 Title
    const h1Match = line.match(/^#\s+(.+)$/);
    if (h1Match && title === todoId) {
      title = cleanMarkdownText(h1Match[1]);
      continue;
    }

    // Markdown Table rows: | Field | Value |
    const tableRow = line.match(/^\|\s*([A-Za-z0-9_-]+)\s*\|\s*([^|]+)\|$/);
    if (tableRow) {
      const field = tableRow[1].toLowerCase();
      const val = tableRow[2].trim();
      if (field === 'status') status = val;
      else if (field === 'priority') priority = val;
      else if (field === 'blocks') blocks = cleanMarkdownText(val);
      else if (field === 'related') relatedPlan = cleanMarkdownText(val);
      else if (field === 'trigger') trigger = cleanMarkdownText(val);
      else if (field === 'area') area = cleanMarkdownText(val);
      continue;
    }

    // Bold key-values: **Status:** open
    const kvMatch = line.match(/^\*\*([A-Za-z0-9_-]+):\*\*\s*(.+)$/);
    if (kvMatch) {
      const field = kvMatch[1].toLowerCase();
      const val = kvMatch[2].trim();
      if (field === 'status') status = val;
      else if (field === 'priority') priority = val;
      else if (field === 'blocks') blocks = cleanMarkdownText(val);
      else if (field === 'related') relatedPlan = cleanMarkdownText(val);
      else if (field === 'trigger') trigger = cleanMarkdownText(val);
      else if (field === 'area') area = cleanMarkdownText(val);
    }
  }

  // Normalize status
  let normStatus = 'open';
  const cleanStatus = status.toLowerCase();
  if (cleanStatus.includes('done') || cleanStatus.includes('close') || cleanStatus.includes('merged')) {
    normStatus = 'done';
  } else if (cleanStatus.includes('prog') || cleanStatus.includes('active')) {
    normStatus = 'in_progress';
  } else if (cleanStatus.includes('block')) {
    normStatus = 'blocked';
  } else if (cleanStatus.includes('wont') || cleanStatus.includes('cancel')) {
    normStatus = 'wont_do';
  } else if (cleanStatus.includes('promot')) {
    normStatus = 'promoted';
  }

  // Normalize priority
  let normPriority = 'P1';
  const prioMatch = priority.toUpperCase().match(/\b(P0|P1|P2)\b/);
  if (prioMatch) normPriority = prioMatch[1];

  return {
    id: todoId,
    title,
    status: normStatus,
    priority: normPriority,
    ...(blocks ? { blocks } : {}),
    ...(relatedPlan ? { relatedPlan } : {}),
    filePath,
    ...(trigger ? { trigger } : {}),
    ...(area ? { area } : {}),
    markdownSource: markdownContent,
    blockedTaskGlobalIds: []
  };
}

module.exports = {
  parsePlanMarkdown,
  parseTodoMarkdown,
  slugify,
  cleanMarkdownText
};
