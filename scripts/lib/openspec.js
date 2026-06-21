/**
 * openspec.js
 * Shared OpenSpec detection and validation utilities for Lift-SDLC scripts.
 * Zero external dependencies — Node.js built-ins only (+ lib/git.js).
 *
 * Exports:
 *   detectActiveChanges, validateChange, validateChangeStrict, isArchived,
 *   runArchive, parseTasks, markTaskDone, STAGE_LABELS
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Human-readable labels for each OpenSpec stage.
 * Values are either strings or functions that receive the change object.
 */
const STAGE_LABELS = {
  'spec-in-progress':           'spec in progress',
  'ready-for-plan':             (change) => `ready for implementation (${change.tasksTotal} tasks)`,
  'implementation-in-progress': (change) => `implementing (${change.tasksDone}/${change.tasksTotal} tasks done)`,
  'tasks-complete':             'tasks complete',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Count .md files recursively in a directory.
 * @param {string} dir
 * @returns {number}
 */
function countMdFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countMdFiles(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      count++;
    }
  }
  return count;
}

/**
 * Parse task completion from tasks.md content.
 * Counts lines matching `^- [x]` (done) and `^- [ ]` (pending).
 * @param {string} content
 * @returns {{ tasksDone: number, tasksTotal: number }}
 */
function parseTaskCompletion(content) {
  const lines = content.split('\n');
  let done = 0;
  let pending = 0;
  for (const line of lines) {
    if (/^- \[x\]/i.test(line)) {
      done++;
    } else if (/^- \[ \]/.test(line)) {
      pending++;
    }
  }
  return { tasksDone: done, tasksTotal: done + pending };
}

/**
 * Derive the OpenSpec stage from artifact status.
 * @param {{ hasTasks: boolean, tasksDone: number, tasksTotal: number }} info
 * @returns {string}
 */
function deriveStage(info) {
  if (!info.hasTasks) {
    return 'spec-in-progress';
  }
  if (info.tasksTotal === 0) {
    return 'spec-in-progress';
  }
  if (info.tasksDone === 0) {
    return 'ready-for-plan';
  }
  if (info.tasksDone >= info.tasksTotal) {
    return 'tasks-complete';
  }
  return 'implementation-in-progress';
}

/**
 * Analyze a single change directory and return its status.
 * @param {string} changeDir  Absolute path to the change directory
 * @param {string} name       Change directory name
 * @returns {object}
 */
function analyzeChange(changeDir, name) {
  const hasProposal = fs.existsSync(path.join(changeDir, 'proposal.md'));
  const hasDesign   = fs.existsSync(path.join(changeDir, 'design.md'));
  const tasksPath   = path.join(changeDir, 'tasks.md');
  const hasTasks    = fs.existsSync(tasksPath);

  const specsDir       = path.join(changeDir, 'specs');
  const deltaSpecCount = countMdFiles(specsDir);

  let tasksDone  = 0;
  let tasksTotal = 0;
  if (hasTasks) {
    const content = fs.readFileSync(tasksPath, 'utf8');
    const parsed  = parseTaskCompletion(content);
    tasksDone     = parsed.tasksDone;
    tasksTotal    = parsed.tasksTotal;
  }

  const stage = deriveStage({ hasTasks, tasksDone, tasksTotal });

  return {
    name,
    stage,
    deltaSpecCount,
    hasProposal,
    hasDesign,
    hasTasks,
    tasksDone,
    tasksTotal,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect all active OpenSpec changes in a project.
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @returns {{ present: boolean, specsCount: number, activeChanges: object[], branchMatch: string|null }}
 */
function detectActiveChanges(projectRoot) {
  const configPath = path.join(projectRoot, 'openspec', 'config.yaml');
  if (!fs.existsSync(configPath)) {
    return { present: false, specsCount: 0, activeChanges: [], branchMatch: null };
  }

  // Count baseline specs in openspec/specs/
  const specsDir      = path.join(projectRoot, 'openspec', 'specs');
  const specsCount    = countMdFiles(specsDir);

  const changesDir    = path.join(projectRoot, 'openspec', 'changes');
  const activeChanges = [];

  if (fs.existsSync(changesDir)) {
    const entries = fs.readdirSync(changesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'archive') continue;
      const changeDir = path.join(changesDir, entry.name);
      // Skip directories without a proposal
      if (!fs.existsSync(path.join(changeDir, 'proposal.md'))) continue;
      activeChanges.push(analyzeChange(changeDir, entry.name));
    }
  }

  // Branch slug matching
  let branchMatch = null;
  try {
    const { exec } = require('./git');
    const branch = exec('git branch --show-current', { cwd: projectRoot });
    if (branch && activeChanges.length > 0) {
      const branchSlug = branch.toLowerCase().replace(/^(feat|fix|chore|refactor|docs)\//, '');
      for (const change of activeChanges) {
        const nameSlug = change.name.toLowerCase();
        const slugRe = new RegExp(
          `(^|[/-])${nameSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[/-])`
        );
        if (branchSlug === nameSlug || slugRe.test(branchSlug)) {
          branchMatch = change.name;
          break;
        }
      }
    }
  } catch {
    // Graceful degradation — skip branch matching if git is unavailable
  }

  return { present: true, specsCount, activeChanges, branchMatch };
}

/**
 * Validate a specific change by name.
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @param {string} changeName   Name of the change directory
 * @returns {{ valid: boolean, errors: string[], ...artifactStatus }}
 */
function validateChange(projectRoot, changeName) {
  const errors   = [];
  const changeDir = path.join(projectRoot, 'openspec', 'changes', changeName);

  if (!fs.existsSync(changeDir)) {
    return {
      valid: false,
      errors: [`Change directory not found: openspec/changes/${changeName}/`],
      name: changeName,
      stage: null,
      deltaSpecCount: 0,
      hasProposal: false,
      hasDesign: false,
      hasTasks: false,
      tasksDone: 0,
      tasksTotal: 0,
    };
  }

  if (!fs.existsSync(path.join(changeDir, 'proposal.md'))) {
    errors.push(`Missing required file: openspec/changes/${changeName}/proposal.md`);
  }

  const specsDir = path.join(changeDir, 'specs');
  if (!fs.existsSync(specsDir) || countMdFiles(specsDir) === 0) {
    errors.push(`Warning: openspec/changes/${changeName}/specs/ is empty or missing`);
  }

  const info = analyzeChange(changeDir, changeName);

  return {
    valid: errors.filter(e => !e.startsWith('Warning:')).length === 0,
    errors,
    ...info,
  };
}

/**
 * Validate a change using the openspec CLI with --strict mode.
 * Unlike `validateChange` (filesystem-based), this shells out to the CLI.
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @param {string} changeName   Name of the change directory
 * @returns {{ ok: boolean, stdout: string, stderr: string, cliAvailable: boolean }}
 */
function validateChangeStrict(projectRoot, changeName) {
  const result = spawnSync('openspec', ['validate', changeName, '--strict'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30000,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      return {
        ok: false,
        stdout: '',
        stderr: 'openspec CLI not found on PATH',
        cliAvailable: false,
      };
    }
    return {
      ok: false,
      stdout: '',
      stderr: result.error.message,
      cliAvailable: true,
    };
  }

  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    cliAvailable: true,
  };
}

/**
 * Check whether a change has already been archived.
 * OpenSpec archives to `openspec/changes/archive/<timestamp>-<name>/` or similar
 * naming with the change name as a suffix.
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @param {string} changeName   Name of the change
 * @returns {boolean}
 */
function isArchived(projectRoot, changeName) {
  const archiveDir = path.join(projectRoot, 'openspec', 'changes', 'archive');
  if (!fs.existsSync(archiveDir)) return false;

  let entries;
  try {
    entries = fs.readdirSync(archiveDir, { withFileTypes: true });
  } catch (_) {
    return false;
  }

  const suffix = `-${changeName}`;
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

/**
 * Run `openspec archive <changeName> --yes` via the CLI.
 * Callers are responsible for validating before calling this.
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @param {string} changeName   Name of the change
 * @param {{ yes?: boolean }} [options]
 * @returns {{ ok: boolean, stdout: string, stderr: string, cliAvailable: boolean }}
 */
function runArchive(projectRoot, changeName, { yes = true } = {}) {
  const args = ['archive', changeName];
  if (yes) args.push('--yes');

  const result = spawnSync('openspec', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 60000,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      return {
        ok: false,
        stdout: '',
        stderr: 'openspec CLI not found on PATH',
        cliAvailable: false,
      };
    }
    return {
      ok: false,
      stdout: '',
      stderr: result.error.message,
      cliAvailable: true,
    };
  }

  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    cliAvailable: true,
  };
}

// ---------------------------------------------------------------------------
// Task-level parsing and mutation (R29/R37 — Fixes #414)
// ---------------------------------------------------------------------------

/**
 * Compute a stable, deterministic reference identifier for an OpenSpec task title.
 * Format: kebab-slug(title) + '-' + first 6 chars of sha256(title).
 * Slug rules: lowercase, non-alnum→'-', collapse '--+'→'-', trim leading/trailing
 * '-', cap at 40 chars. Same title → same ref across invocations.
 * @param {string} title
 * @returns {string}
 */
function computeRef(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  const hash = crypto.createHash('sha256').update(String(title)).digest('hex').slice(0, 6);
  return `${slug}-${hash}`;
}

/**
 * Extract the value inside an inline `<!-- ref:<id> -->` HTML comment on a line.
 * Returns the ref string or null if no such comment is present.
 * @param {string} line
 * @returns {string|null}
 */
function extractInlineRef(line) {
  const m = /<!--\s*ref:([^\s]+?)\s*-->/.exec(line);
  return m ? m[1] : null;
}

/**
 * Parse a tasks.md content blob into structured task entries.
 *
 * The override-via-comment semantics: when a line carries `<!-- ref:<id> -->`,
 * the comment value OVERRIDES the computed hash. This preserves the historical
 * mapping after a task is reworded (the hash would otherwise drift).
 *
 * @param {string} content  Raw string content of tasks.md
 * @returns {Array<{ ref: string, line: number, title: string, indent: number, done: boolean }>}
 */
function parseTasks(content) {
  const lines = String(content == null ? '' : content).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const m = /^([ \t]*)- \[([ xX])\] (.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    const done = m[2].toLowerCase() === 'x';
    // Strip any inline HTML comments from the visible title.
    const rawAfterBox = m[3];
    const inlineRef = extractInlineRef(rawAfterBox);
    const title = rawAfterBox.replace(/\s*<!--[\s\S]*?-->\s*$/g, '').trim();
    const ref = inlineRef || computeRef(title);
    out.push({ ref, line: i + 1, title, indent, done });
  }
  return out;
}

/**
 * Mark an OpenSpec task as done. Pure-IO, idempotent, never throws.
 *
 * Resolution priority:
 *   1. Line ending with `<!-- ref:<taskRef> -->` HTML comment.
 *   2. (fallback) 1-indexed `line` if provided AND that line text starts with `- [ ] <title>`.
 *   3. (fallback) First `- [ ] <title>` exact title match.
 *
 * Return shape: { changed, reason, line }
 *   - { changed: true,  reason: null,           line: N }    — line flipped
 *   - { changed: false, reason: 'already-done', line: N }    — resolved and already [x]
 *   - { changed: false, reason: 'not-found',    line: null } — no resolution path matched
 *   - { changed: false, reason: 'io-error',     line: null } — read/write failed
 *
 * @param {string} changeName
 * @param {string} taskRef
 * @param {{ line?: number, title?: string }} [opts]
 * @param {{ projectRoot?: string }} [env]
 * @returns {{ changed: boolean, reason: 'already-done'|'not-found'|'io-error'|null, line: number|null }}
 */
function markTaskDone(changeName, taskRef, opts = {}, env = {}) {
  // Path-traversal guard: changeName is caller-supplied (LLM/CLI) and is interpolated
  // into a filesystem path. Reject empty, separator, or parent-ref components so the
  // resulting path cannot escape openspec/changes/<changeName>/.
  if (
    !changeName ||
    typeof changeName !== 'string' ||
    changeName.includes('/') ||
    changeName.includes('\\') ||
    changeName.includes('..') ||
    changeName.includes('\0')
  ) {
    return { changed: false, reason: 'io-error', line: null };
  }
  const projectRoot = env && env.projectRoot ? env.projectRoot : process.cwd();
  const tasksPath = path.join(projectRoot, 'openspec', 'changes', changeName, 'tasks.md');

  let content;
  try {
    content = fs.readFileSync(tasksPath, 'utf8');
  } catch (_) {
    return { changed: false, reason: 'io-error', line: null };
  }

  const lines = content.split('\n');
  const optLine = typeof opts.line === 'number' ? opts.line : null;
  const optTitle = typeof opts.title === 'string' ? opts.title : null;

  let resolvedIdx = -1; // 0-indexed
  let alreadyDone = false;

  // Priority 1: comment-bearing line.
  if (taskRef) {
    for (let i = 0; i < lines.length; i++) {
      const inline = extractInlineRef(lines[i]);
      if (inline && inline === taskRef) {
        const m = /^([ \t]*)- \[([ xX])\] /.exec(lines[i]);
        if (m) {
          resolvedIdx = i;
          alreadyDone = m[2].toLowerCase() === 'x';
          break;
        }
      }
    }
  }

  // Priority 2: 1-indexed line hint + title prefix.
  if (resolvedIdx === -1 && optLine != null && optTitle != null) {
    const idx = optLine - 1;
    if (idx >= 0 && idx < lines.length) {
      const m = /^([ \t]*)- \[([ xX])\] (.*)$/.exec(lines[idx]);
      if (m) {
        const titleOnLine = m[3].replace(/\s*<!--[\s\S]*?-->\s*$/g, '').trim();
        if (titleOnLine === optTitle.trim()) {
          resolvedIdx = idx;
          alreadyDone = m[2].toLowerCase() === 'x';
        }
      }
    }
  }

  // Priority 3: exact title match anywhere.
  if (resolvedIdx === -1 && optTitle != null) {
    const wanted = optTitle.trim();
    for (let i = 0; i < lines.length; i++) {
      const m = /^([ \t]*)- \[([ xX])\] (.*)$/.exec(lines[i]);
      if (!m) continue;
      const titleOnLine = m[3].replace(/\s*<!--[\s\S]*?-->\s*$/g, '').trim();
      if (titleOnLine === wanted) {
        resolvedIdx = i;
        alreadyDone = m[2].toLowerCase() === 'x';
        break;
      }
    }
  }

  if (resolvedIdx === -1) {
    return { changed: false, reason: 'not-found', line: null };
  }

  if (alreadyDone) {
    return { changed: false, reason: 'already-done', line: resolvedIdx + 1 };
  }

  // Flip [ ] → [x] preserving everything else on the line.
  lines[resolvedIdx] = lines[resolvedIdx].replace(/^([ \t]*)- \[ \] /, '$1- [x] ');

  try {
    fs.writeFileSync(tasksPath, lines.join('\n'), 'utf8');
  } catch (_) {
    return { changed: false, reason: 'io-error', line: null };
  }

  return { changed: true, reason: null, line: resolvedIdx + 1 };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  detectActiveChanges,
  validateChange,
  validateChangeStrict,
  isArchived,
  runArchive,
  parseTasks,
  markTaskDone,
  STAGE_LABELS,
};
