#!/usr/bin/env node
/**
 * execute-state.js
 * CLI wrapper for managing execute-plan-sdlc execution state files.
 * Delegates all I/O to lib/state.js; zero npm dependencies.
 *
 * Usage:
 *   node execute-state.js init        --branch <b> --quality <X> --total-tasks <n> [--planned-task-ids <json>] [--plan-path <p>] [--plan-hash <h>]
 *   node execute-state.js wave-start  --wave <n> [--tasks-json <json>] [--run-id <id>]
 *   node execute-state.js wave-done   --wave <n>
 *   node execute-state.js wave-fail   --wave <n>
 *   node execute-state.js wave-committed --branch <b> --wave <n> --sha <sha>
 *   node execute-state.js task-done   --wave <n> --task <id> --name <name> --complexity <c> --risk <r> --files-changed <json>
 *   node execute-state.js task-fail   --wave <n> --task <id> --name <name> --complexity <c> --risk <r> --error <text> [--skipped-dependency]
 *   node execute-state.js context     --data <json>
 *   node execute-state.js read        [--branch <b>]
 *   node execute-state.js cleanup     [--branch <b>]
 *   node execute-state.js gc          [--ttl-days <N>] [--dry-run]
 *   node execute-state.js summarize-prior-wave-context [--run-id <id>] [--max-files <n>] [--max-decisions <n>] [--max-interfaces <n>]
 *   node execute-state.js wave-split --wave <n> --dispatched <json-id-array> [--missing-ids <json-id-array>] [--split-depth <n>] [--max-split-depth <n>]
 *   node execute-state.js verify-completeness --run-id <id>
 *   node execute-state.js detect-resume --branch <name>
 *
 * Exit codes:
 *   0 = success
 *   1 = state file not found (read/cleanup)
 *   2 = unexpected error
 *   65 = verify-completeness only — one or more planned tasks unaccounted
 *        for (BSD EX_DATAERR; see that command's own docstring below)
 */

'use strict';

const path = require('node:path');
const fs   = require('node:fs');
const { spawnSync } = require('node:child_process');
const LIB = path.join(__dirname, '..', 'lib');

const {
  slugifyBranch, readState, writeState, initState, deleteState, resolveBranch,
  gcStateFiles, resolveStateDir, parseStateFilename,
  listBranches, readTtlDaysFromConfig, summarizePriorWaveContext, detectResumeState,
} = require(path.join(LIB, 'state'));

const { writeTaskFactSheet, taskFactSheetPath } = require(path.join(LIB, 'task-factsheet'));
const { splitWave, MaxSplitDepthExceededError } = require(path.join(LIB, 'wave-split'));

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { subcommand: args[0] || null };

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--branch' && args[i + 1]) {
      result.branch = args[++i];
    } else if (a === '--quality' && args[i + 1]) {
      result.quality = args[++i];
    } else if (a === '--preset') {
      // Hard-removed (#190): --preset renamed to --quality. Consume the
      // following value (if any) and surface a clear error so callers update
      // their invocations. The error is written to stderr and exits non-zero;
      // the orchestrator surfaces it in the agent prompt.
      if (args[i + 1] && !args[i + 1].startsWith('--')) i++;
      result._presetRejected = true;
    } else if (a === '--total-tasks' && args[i + 1]) {
      const val = parseInt(args[++i], 10);
      if (isNaN(val)) { process.stderr.write(`Error: --total-tasks requires a number, got "${args[i]}"\n`); process.exit(2); }
      result.totalTasks = val;
    } else if (a === '--planned-task-ids' && args[i + 1]) {
      result.plannedTaskIds = args[++i];
    } else if (a === '--plan-path' && args[i + 1]) {
      result.planPath = args[++i];
    } else if (a === '--plan-hash' && args[i + 1]) {
      result.planHash = args[++i];
    } else if (a === '--wave' && args[i + 1]) {
      const val = parseInt(args[++i], 10);
      if (isNaN(val)) { process.stderr.write(`Error: --wave requires a number, got "${args[i]}"\n`); process.exit(2); }
      result.wave = val;
    } else if (a === '--task' && args[i + 1]) {
      result.task = args[++i];
    } else if (a === '--name' && args[i + 1]) {
      result.name = args[++i];
    } else if (a === '--complexity' && args[i + 1]) {
      result.complexity = args[++i];
    } else if (a === '--risk' && args[i + 1]) {
      result.risk = args[++i];
    } else if (a === '--files-changed' && args[i + 1]) {
      result.filesChanged = args[++i];
    } else if (a === '--error' && args[i + 1]) {
      result.error = args[++i];
    } else if (a === '--data' && args[i + 1]) {
      result.data = args[++i];
    } else if (a === '--sha' && args[i + 1]) {
      result.sha = args[++i];
    } else if (a === '--ttl-days' && args[i + 1]) {
      const val = parseInt(args[++i], 10);
      if (isNaN(val)) { process.stderr.write(`Error: --ttl-days requires a number, got "${args[i]}"\n`); process.exit(2); }
      result.ttlDays = val;
    } else if (a === '--dry-run') {
      result.dryRun = true;
    } else if (a === '--tasks-json' && args[i + 1]) {
      result.tasksJson = args[++i];
    } else if (a === '--run-id' && args[i + 1]) {
      result.runId = args[++i];
    } else if (a === '--max-files' && args[i + 1]) {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) result.maxFiles = val;
    } else if (a === '--max-decisions' && args[i + 1]) {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) result.maxDecisions = val;
    } else if (a === '--max-interfaces' && args[i + 1]) {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) result.maxInterfaces = val;
    } else if (a === '--dispatched' && args[i + 1]) {
      result.dispatched = args[++i];
    } else if (a === '--missing-ids' && args[i + 1]) {
      result.missingIds = args[++i];
    } else if (a === '--split-depth' && args[i + 1]) {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) result.splitDepth = val;
    } else if (a === '--max-split-depth' && args[i + 1]) {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) result.maxSplitDepth = val;
    } else if (a === '--state-file' && args[i + 1]) {
      result.stateFile = args[++i];
    } else if (a === '--skipped-dependency') {
      result.skippedDependency = true;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Branch resolution
// ---------------------------------------------------------------------------

function resolveBranchOrExit(argBranch) {
  try {
    return resolveBranch(argBranch);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Wave helpers
// ---------------------------------------------------------------------------

function findOrCreateWave(waves, waveNumber) {
  let wave = waves.find(w => w.number === waveNumber);
  if (!wave) {
    wave = { number: waveNumber, status: 'in_progress', startedAt: new Date().toISOString(), tasks: [] };
    waves.push(wave);
  }
  return wave;
}

// ---------------------------------------------------------------------------
// Deep merge helper (arrays concatenate, objects merge, scalars overwrite)
// ---------------------------------------------------------------------------

function deepMerge(target, source) {
  if (source === null || typeof source !== 'object') return source;
  if (Array.isArray(source)) {
    if (Array.isArray(target)) return target.concat(source);
    return source.slice();
  }
  const result = Object.assign({}, target);
  for (const key of Object.keys(source)) {
    if (
      key in result &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key]) &&
      typeof source[key] === 'object' &&
      source[key] !== null &&
      !Array.isArray(source[key])
    ) {
      result[key] = deepMerge(result[key], source[key]);
    } else if (Array.isArray(result[key]) && Array.isArray(source[key])) {
      result[key] = result[key].concat(source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

function cmdInit(opts) {
  if (opts._presetRejected) {
    process.stderr.write('Error: --preset is no longer accepted by execute-plan-sdlc state init. Use --quality <full|balanced|minimal> instead (#190).\n');
    process.exit(2);
  }
  if (!opts.branch) {
    process.stderr.write('Error: --branch is required for init\n');
    process.exit(2);
  }
  if (!opts.quality) {
    process.stderr.write('Error: --quality is required for init (--preset was renamed to --quality, #190)\n');
    process.exit(2);
  }
  if (opts.totalTasks == null || isNaN(opts.totalTasks)) {
    process.stderr.write('Error: --total-tasks is required for init\n');
    process.exit(2);
  }

  let plannedTaskIds = null;
  if (opts.plannedTaskIds) {
    try {
      plannedTaskIds = JSON.parse(opts.plannedTaskIds);
      if (!Array.isArray(plannedTaskIds)) throw new Error('must be an array');
    } catch (e) {
      process.stderr.write(`Error: --planned-task-ids must be a JSON array: ${e.message}\n`);
      process.exit(2);
    }
  }

  const data = {
    version: 1,
    skill: 'execute-plan-sdlc',
    startedAt: new Date().toISOString(),
    branch: opts.branch,
    planPath: opts.planPath || null,
    planHash: opts.planHash || null,
    quality: opts.quality,
    totalTasks: opts.totalTasks,
    plannedTaskIds: plannedTaskIds,
    waves: [],
    context: {},
  };

  try {
    const filePath = initState('execute', opts.branch, data);
    process.stdout.write(filePath + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(2);
  }
}

function cmdWaveStart(opts) {
  if (opts.wave == null || isNaN(opts.wave)) {
    process.stderr.write('Error: --wave is required\n');
    process.exit(2);
  }

  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState('execute', slug);
  if (!found) {
    process.stderr.write(`Error: no state file found for branch "${branch}"\n`);
    process.exit(1);
  }

  const { data, filePath } = found;
  if (!Array.isArray(data.waves)) data.waves = [];

  const wave = data.waves.find(w => w.number === opts.wave);
  if (wave) {
    wave.status = 'in_progress';
    wave.startedAt = new Date().toISOString();
  } else {
    data.waves.push({
      number: opts.wave,
      status: 'in_progress',
      startedAt: new Date().toISOString(),
      tasks: [],
    });
  }

  writeState(filePath, data);

  // Write per-task fact sheets when --tasks-json is provided (R-FACT-SHEET-DISPATCH, #432).
  // --tasks-json is a JSON array of task objects; --run-id is the execution run ID
  // (defaults to the state file's startedAt timestamp slug when not provided).
  if (opts.tasksJson) {
    let tasks;
    try {
      tasks = JSON.parse(opts.tasksJson);
    } catch (e) {
      process.stderr.write(`Error: --tasks-json is not valid JSON: ${e.message}\n`);
      process.exit(2);
    }
    if (!Array.isArray(tasks)) {
      process.stderr.write('Error: --tasks-json must be a JSON array\n');
      process.exit(2);
    }
    const stateDir = resolveStateDir();
    // Derive runId from --run-id flag or from the state file's startedAt field
    const runId = opts.runId || (data.startedAt
      ? data.startedAt.replace(/[^0-9T]/g, '').replace('T', 'T')
      : `wave-${opts.wave}`);
    const writtenPaths = [];
    for (const task of tasks) {
      if (!task || !task.id) continue; // skip malformed entries
      try {
        const p = writeTaskFactSheet(task, { runId, stateDir });
        writtenPaths.push(p);
      } catch (e) {
        process.stderr.write(`Warning: failed to write fact sheet for task ${task.id}: ${e.message}\n`);
      }
    }
    if (writtenPaths.length > 0) {
      process.stdout.write(JSON.stringify({ factSheets: writtenPaths }) + '\n');
    }
  }

  process.exit(0);
}

function cmdWaveDone(opts) {
  if (opts.wave == null || isNaN(opts.wave)) {
    process.stderr.write('Error: --wave is required\n');
    process.exit(2);
  }

  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState('execute', slug);
  if (!found) {
    process.stderr.write(`Error: no state file found for branch "${branch}"\n`);
    process.exit(1);
  }

  const { data, filePath } = found;
  if (!Array.isArray(data.waves)) data.waves = [];

  const wave = findOrCreateWave(data.waves, opts.wave);
  wave.status = 'completed';
  wave.completedAt = new Date().toISOString();

  writeState(filePath, data);
  process.exit(0);
}

function cmdWaveFail(opts) {
  if (opts.wave == null || isNaN(opts.wave)) {
    process.stderr.write('Error: --wave is required\n');
    process.exit(2);
  }

  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState('execute', slug);
  if (!found) {
    process.stderr.write(`Error: no state file found for branch "${branch}"\n`);
    process.exit(1);
  }

  const { data, filePath } = found;
  if (!Array.isArray(data.waves)) data.waves = [];

  const wave = findOrCreateWave(data.waves, opts.wave);
  wave.status = 'failed';
  wave.completedAt = new Date().toISOString();

  writeState(filePath, data);
  process.exit(0);
}

/**
 * `wave-committed` — record the per-wave WIP commit sha on a completed wave.
 * Implements Fixes #392 / R35 (`--commit-waves` state persistence).
 *
 * Idempotent on identical sha (re-running with the same sha is a no-op).
 * Errors when the wave already has a different committedSha (conflict).
 * Accepts `--sha ""` or omitted `--sha` as the explicit "no diff produced
 * a commit" soft-success path: persists `committedSha: null`.
 */
function cmdWaveCommitted(opts) {
  if (opts.wave == null || isNaN(opts.wave)) {
    process.stderr.write('Error: --wave is required\n');
    process.exit(2);
  }

  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState('execute', slug);
  if (!found) {
    process.stderr.write(`Error: no state file found for branch "${branch}"\n`);
    process.exit(1);
  }

  const { data, filePath } = found;
  if (!Array.isArray(data.waves)) data.waves = [];

  const wave = data.waves.find(w => w.number === opts.wave);
  if (!wave) {
    process.stderr.write(`Error: wave ${opts.wave} not found in state\n`);
    process.exit(2);
  }

  if (wave.status !== 'completed') {
    process.stderr.write(`Error: wave ${opts.wave} status is "${wave.status}", expected "completed"\n`);
    process.exit(2);
  }

  // Normalize sha: empty string or undefined → null (soft-success "no diff")
  const newSha = (typeof opts.sha === 'string' && opts.sha.length > 0) ? opts.sha : null;

  // Idempotency / conflict check
  if ('committedSha' in wave) {
    if (wave.committedSha === newSha) {
      // No-op: identical sha (or both null)
      process.exit(0);
    }
    process.stderr.write(`Error: wave ${opts.wave} already has committedSha "${wave.committedSha}" — refusing to overwrite with "${newSha}"\n`);
    process.exit(2);
  }

  wave.committedSha = newSha;
  writeState(filePath, data);
  process.exit(0);
}

function cmdTaskDone(opts) {
  if (opts.wave == null || isNaN(opts.wave)) {
    process.stderr.write('Error: --wave is required\n');
    process.exit(2);
  }
  if (!opts.task) {
    process.stderr.write('Error: --task is required\n');
    process.exit(2);
  }

  let filesChanged;
  try {
    filesChanged = opts.filesChanged ? JSON.parse(opts.filesChanged) : [];
  } catch (e) {
    process.stderr.write(`Error: --files-changed is not valid JSON: ${e.message}\n`);
    process.exit(2);
  }

  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState('execute', slug);
  if (!found) {
    process.stderr.write(`Error: no state file found for branch "${branch}"\n`);
    process.exit(1);
  }

  const { data, filePath } = found;
  if (!Array.isArray(data.waves)) data.waves = [];

  const wave = findOrCreateWave(data.waves, opts.wave);
  if (!Array.isArray(wave.tasks)) wave.tasks = [];

  const taskEntry = {
    id: opts.task,
    name: opts.name || '',
    complexity: opts.complexity || '',
    risk: opts.risk || '',
    status: 'completed',
    filesChanged: Array.isArray(filesChanged) ? filesChanged : [],
  };

  const existingIdx = wave.tasks.findIndex(t => t.id === opts.task);
  if (existingIdx >= 0) {
    wave.tasks[existingIdx] = taskEntry;
  } else {
    wave.tasks.push(taskEntry);
  }

  writeState(filePath, data);
  process.exit(0);
}

function cmdTaskFail(opts) {
  if (opts.wave == null || isNaN(opts.wave)) {
    process.stderr.write('Error: --wave is required\n');
    process.exit(2);
  }
  if (!opts.task) {
    process.stderr.write('Error: --task is required\n');
    process.exit(2);
  }

  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState('execute', slug);
  if (!found) {
    process.stderr.write(`Error: no state file found for branch "${branch}"\n`);
    process.exit(1);
  }

  const { data, filePath } = found;
  if (!Array.isArray(data.waves)) data.waves = [];

  const wave = findOrCreateWave(data.waves, opts.wave);
  if (!Array.isArray(wave.tasks)) wave.tasks = [];

  // Support SKIPPED-DEPENDENCY status (R-INVARIANT-COMPLETENESS, T9, #432).
  // When --skipped-dependency is passed, the task is recorded with status
  // 'skipped-dependency' (counted as accounted by verify-completeness).
  // No schema change: uses the existing status field.
  const taskStatus = opts.skippedDependency ? 'skipped-dependency' : 'failed';

  const taskEntry = {
    id: opts.task,
    name: opts.name || '',
    complexity: opts.complexity || '',
    risk: opts.risk || '',
    status: taskStatus,
    filesChanged: [],
    error: opts.error || '',
  };

  const existingIdx = wave.tasks.findIndex(t => t.id === opts.task);
  if (existingIdx >= 0) {
    wave.tasks[existingIdx] = taskEntry;
  } else {
    wave.tasks.push(taskEntry);
  }

  writeState(filePath, data);
  process.exit(0);
}

function cmdContext(opts) {
  if (!opts.data) {
    process.stderr.write('Error: --data is required\n');
    process.exit(2);
  }

  let incoming;
  try {
    incoming = JSON.parse(opts.data);
  } catch (e) {
    process.stderr.write(`Error: --data is not valid JSON: ${e.message}\n`);
    process.exit(2);
  }

  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState('execute', slug);
  if (!found) {
    process.stderr.write(`Error: no state file found for branch "${branch}"\n`);
    process.exit(1);
  }

  const { data, filePath } = found;
  if (!data.context || typeof data.context !== 'object') data.context = {};
  data.context = deepMerge(data.context, incoming);

  writeState(filePath, data);
  process.exit(0);
}

function cmdRead(opts) {
  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState('execute', slug);
  if (!found) {
    process.stderr.write(`Error: no state file found for branch "${branch}"\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(found.data, null, 2) + '\n');
  process.exit(0);
}

function cmdCleanup(opts) {
  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState('execute', slug);
  if (!found) {
    // Nothing to delete — treat as success
    process.exit(0);
  }

  deleteState(found.filePath);
  process.exit(0);
}

/**
 * `gc` — prune stale execute-state files. Mirrors `state/ship.js gc` but
 * scoped to the `execute-` prefix only.
 */
function cmdGc(opts) {
  const ttlDays = (typeof opts.ttlDays === 'number') ? opts.ttlDays : readTtlDaysFromConfig();
  const knownBranches = listBranches();

  if (opts.dryRun) {
    const stateDir = resolveStateDir();
    const liveSlugs = new Set(knownBranches.map(slugifyBranch));
    const now = Date.now();
    const ttlMs = ttlDays * 86400000;
    const out = { execute: { wouldDelete: [], wouldKeep: [] }, plan: { wouldDelete: [], wouldKeep: [] } };

    let entries = [];
    try { entries = fs.readdirSync(stateDir); } catch (_) { /* empty */ }

    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const parsed = parseStateFilename(name);
      if (!parsed) continue;
      const bucket = out[parsed.prefix];
      if (!bucket) continue;
      let stat;
      try { stat = fs.statSync(path.join(stateDir, name)); } catch (_) { continue; }
      const fresh = (now - stat.mtimeMs) < ttlMs;
      const branchExists = liveSlugs.has(parsed.slug);
      if (fresh) {
        bucket.wouldKeep.push({ file: name, branch: parsed.slug, reason: 'ttl-fresh' });
      } else if (branchExists) {
        bucket.wouldKeep.push({ file: name, branch: parsed.slug, reason: 'branch-exists' });
      } else {
        bucket.wouldDelete.push({ file: name, branch: parsed.slug, reason: 'stale+branch-gone' });
      }
    }

    process.stdout.write(JSON.stringify({ dryRun: true, ttlDays, ...out }, null, 2) + '\n');
    process.exit(0);
  }

  const execute = gcStateFiles({ prefix: 'execute', ttlDays, knownBranches });
  const plan    = gcStateFiles({ prefix: 'plan',    ttlDays, knownBranches });
  process.stdout.write(JSON.stringify({ ttlDays, execute, plan }, null, 2) + '\n');
  process.exit(0);
}

/**
 * `wave-split` — persist a CONTEXT_OVERFLOW split decision to state for resume safety.
 *
 * Calls lib/wave-split.js splitWave() with the provided dispatched/missing-ids arrays,
 * records the resulting split tree on the wave entry, and prints the JSON result to stdout.
 *
 * Idempotent: if the wave already has a splitTree for the same splitDepth, returns the
 * persisted tree without re-computing (same inputs → same partition is guaranteed by splitWave).
 *
 * Exit codes:
 *   0 = success; JSON printed to stdout
 *   2 = argument error, JSON parse error, MaxSplitDepthExceededError
 *
 * Implements R-CONTEXT_OVERFLOW, T8, #432.
 */
function cmdWaveSplit(opts) {
  if (opts.wave == null || isNaN(opts.wave)) {
    process.stderr.write('Error: --wave is required\n');
    process.exit(2);
  }
  if (!opts.dispatched) {
    process.stderr.write('Error: --dispatched is required (JSON array of task ID strings)\n');
    process.exit(2);
  }

  let dispatched;
  try {
    dispatched = JSON.parse(opts.dispatched);
  } catch (e) {
    process.stderr.write(`Error: --dispatched is not valid JSON: ${e.message}\n`);
    process.exit(2);
  }
  if (!Array.isArray(dispatched)) {
    process.stderr.write('Error: --dispatched must be a JSON array\n');
    process.exit(2);
  }

  let missingIds = [];
  if (opts.missingIds) {
    try {
      missingIds = JSON.parse(opts.missingIds);
    } catch (e) {
      process.stderr.write(`Error: --missing-ids is not valid JSON: ${e.message}\n`);
      process.exit(2);
    }
    if (!Array.isArray(missingIds)) {
      process.stderr.write('Error: --missing-ids must be a JSON array\n');
      process.exit(2);
    }
  }

  const splitDepth    = opts.splitDepth    != null ? opts.splitDepth    : 0;
  const maxSplitDepth = opts.maxSplitDepth != null ? opts.maxSplitDepth : 3;

  // Compute split (pure, deterministic)
  let result;
  try {
    result = splitWave({ dispatched, missingIds, splitDepth, maxSplitDepth });
  } catch (e) {
    if (e instanceof MaxSplitDepthExceededError) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }

  // Persist split tree to state so resume-after-crash can replay the same partition.
  // Best-effort: if state lookup fails, still emit the result to stdout (idempotent).
  try {
    let found = null;

    // Support direct --state-file path (used in tests + orchestration)
    if (opts.stateFile) {
      try {
        const raw = fs.readFileSync(opts.stateFile, 'utf8');
        const data = JSON.parse(raw);
        found = { data, filePath: opts.stateFile };
      } catch (_) {
        // fall through — no state to persist to
      }
    } else {
      const branch = resolveBranchOrExit(opts.branch);
      const slug = slugifyBranch(branch);
      found = readState('execute', slug);
    }

    if (found) {
      const { data, filePath } = found;
      if (!Array.isArray(data.waves)) data.waves = [];

      const wave = findOrCreateWave(data.waves, opts.wave);

      // Idempotency: if same splitDepth already recorded, skip write
      if (!wave.splitTree || wave.splitTree.splitDepth !== splitDepth) {
        wave.splitTree = {
          splitDepth,
          maxSplitDepth,
          dispatched: [...dispatched],
          missingIds: [...missingIds],
          halves: result.halves,
          computedAt: new Date().toISOString(),
        };
        writeState(filePath, data);
      }
    }
  } catch (_) {
    // State persistence is best-effort; never fail the command due to state I/O errors
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

/**
 * `verify-completeness` — post-execution completeness invariant (R-INVARIANT-COMPLETENESS, #432).
 *
 * Reads the execute state file (by current branch or --run-id / --state-file),
 * collects every task entry across all waves, and checks whether the union of
 * accounted task IDs covers the full planned set.
 *
 * Accounted statuses: 'completed', 'failed', 'skipped-dependency'.
 * Any task whose ID appears in state with one of these statuses is accounted.
 *
 * Exit codes:
 *   0  — all planned tasks accounted for
 *   65 — one or more planned tasks unaccounted; stderr JSON: {missingIds, totalPlanned, totalAccounted}
 *   2  — argument or state error
 *
 * Idempotent: re-running on same state returns the same verdict.
 *
 * Implements R-INVARIANT-COMPLETENESS, T9, #432.
 */
function cmdVerifyCompleteness(opts) {
  const ACCOUNTED_STATUSES = new Set(['completed', 'failed', 'skipped-dependency']);

  // Resolve state
  let found = null;

  if (opts.stateFile) {
    // Direct file path (used in tests)
    try {
      const raw = fs.readFileSync(opts.stateFile, 'utf8');
      const data = JSON.parse(raw);
      found = { data, filePath: opts.stateFile };
    } catch (e) {
      process.stderr.write(`Error: cannot read state file "${opts.stateFile}": ${e.message}\n`);
      process.exit(2);
    }
  } else {
    const branch = resolveBranchOrExit(opts.branch);
    const slug = slugifyBranch(branch);
    found = readState('execute', slug);
    if (!found) {
      process.stderr.write(`Error: no state file found for branch "${branch}"\n`);
      process.exit(1);
    }
  }

  const { data } = found;

  // Collect all task entries across waves
  const waves = Array.isArray(data.waves) ? data.waves : [];
  const accountedById = new Map(); // id → status

  for (const wave of waves) {
    const tasks = Array.isArray(wave.tasks) ? wave.tasks : [];
    for (const task of tasks) {
      if (!task || !task.id) continue;
      // Last write wins (task-fail after task-done, etc.)
      if (!accountedById.has(task.id) || ACCOUNTED_STATUSES.has(task.status)) {
        accountedById.set(task.id, task.status);
      }
    }
  }

  // Determine planned task IDs. Prefer state.plannedTaskIds[] if present;
  // fall back to totalTasks count (not reliable for ID listing).
  // The canonical source is state.context.plannedTaskIds when set by init.
  const plannedIds = Array.isArray(data.plannedTaskIds)
    ? data.plannedTaskIds
    : (data.context && Array.isArray(data.context.plannedTaskIds)
        ? data.context.plannedTaskIds
        : null);

  if (!plannedIds) {
    // Cannot verify without planned task ID list — plannedTaskIds missing means the state is
    // structurally incomplete (pre-#432 state or corrupted init). Hard-fail so ship-sdlc does
    // not silently advance past an unverifiable execute step (R-INVARIANT-COMPLETENESS, #432).
    process.stderr.write(
      'ERROR: verify-completeness cannot find plannedTaskIds in state — invariant check cannot run. Use --resume on a fresh execute run, or re-run without --resume to start over.\n'
    );
    process.exit(2);
  }

  // Normalize IDs for comparison (R-IDNORM): strip leading T/t so "T1" == "1".
  // Comparison-only — persisted IDs in state retain their wire form.
  function normalizeId(id) {
    return typeof id === 'string' ? id.trim().replace(/^[Tt](?=\d)/, '') : id;
  }

  // Build a normalized lookup from the accounted map
  const accountedByNormId = new Map();
  for (const [id, status] of accountedById.entries()) {
    accountedByNormId.set(normalizeId(id), status);
  }

  // Find accounted and missing
  const accountedIds = plannedIds.filter(id => {
    const status = accountedByNormId.get(normalizeId(id));
    return status !== undefined && ACCOUNTED_STATUSES.has(status);
  });
  const missingIds = plannedIds.filter(id => !accountedIds.includes(id));

  const totalPlanned  = plannedIds.length;
  const totalAccounted = accountedIds.length;

  if (missingIds.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, totalPlanned, totalAccounted }) + '\n');
    process.exit(0);
  }

  // Incomplete — exit 65 (BSD EX_DATAERR) with structured stderr JSON
  process.stderr.write(JSON.stringify({ missingIds, totalPlanned, totalAccounted }) + '\n');
  process.exit(65);
}

/**
 * summarize-prior-wave-context — return bounded slice of execution context.
 * Reads state for current branch and applies caps via state.js::summarizePriorWaveContext.
 * Outputs JSON to stdout. (R-BYTE-BUDGET / T4, #432)
 */
function cmdSummarizePriorWaveContext(opts) {
  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);

  // Support --run-id as an alternate lookup path (for test harnesses that don't
  // have a git repo, e.g. when SDLC_STATE_DIR_OVERRIDE is set).
  const found = readState('execute', slug);
  if (!found) {
    process.stderr.write(`Error: no state file found for branch "${branch}"\n`);
    process.exit(1);
  }

  const caps = {};
  if (opts.maxFiles      != null) caps.maxFiles      = opts.maxFiles;
  if (opts.maxDecisions  != null) caps.maxDecisions  = opts.maxDecisions;
  if (opts.maxInterfaces != null) caps.maxInterfaces = opts.maxInterfaces;

  const summary = summarizePriorWaveContext(found.data, caps);
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exit(0);
}

/**
 * `detect-resume` — CLI-expose `lib/state.js::detectResumeState()` for
 * execute-plan-sdlc's Step 0 resume detection, plus a per-wave `committedSha`
 * reachability check (Fixes #392 / R35 resume gate).
 *
 * No new resume-detection logic lives here: `detectResumeState()` supplies
 * the `{stateFile, fullPath, found, fresh, nextPendingStep}` shape verbatim
 * (mirrors ship.js's resume probe), and `readState()` supplies the parsed
 * wave data for the reachability check — both already wired through
 * `resolveStateDir()`/`findStateFile()`/`slugifyBranch()` internally.
 *
 * Appends `waveShaStatus`: for each wave in the found state file, classifies
 * its `committedSha` via `git merge-base --is-ancestor <sha> HEAD`:
 *   - `committedSha` null/absent → `reachable: null`  (not applicable)
 *   - ancestor of HEAD (exit 0)  → `reachable: true`   (reachable)
 *   - not an ancestor (exit !=0) → `reachable: false`  (diverged)
 *
 * Output: {stateFile, fullPath, found, fresh, nextPendingStep, waveShaStatus}
 * Always exits 0 — `found: false` is a valid answer, not an error.
 */
function cmdDetectResume(opts) {
  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const result = detectResumeState({ prefix: 'execute', branch });

  const waveShaStatus = [];
  if (result.found) {
    const found = readState('execute', slug);
    const waves = (found && Array.isArray(found.data.waves)) ? found.data.waves : [];
    for (const wave of waves) {
      const sha = (typeof wave.committedSha === 'string' && wave.committedSha.length > 0)
        ? wave.committedSha
        : null;
      let reachable = null;
      if (sha) {
        const check = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { encoding: 'utf8' });
        reachable = check.status === 0;
      }
      waveShaStatus.push({ wave: wave.number, committedSha: sha, reachable });
    }
  }

  process.stdout.write(JSON.stringify({ ...result, waveShaStatus }) + '\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  const opts = parseArgs(process.argv);

  switch (opts.subcommand) {
    case 'init':        cmdInit(opts);       break;
    case 'wave-start':  cmdWaveStart(opts);  break;
    case 'wave-done':   cmdWaveDone(opts);   break;
    case 'wave-fail':   cmdWaveFail(opts);   break;
    case 'wave-committed': cmdWaveCommitted(opts); break;
    case 'task-done':   cmdTaskDone(opts);   break;
    case 'task-fail':   cmdTaskFail(opts);   break;
    case 'context':     cmdContext(opts);    break;
    case 'read':        cmdRead(opts);       break;
    case 'cleanup':     cmdCleanup(opts);    break;
    case 'gc':          cmdGc(opts);         break;
    case 'summarize-prior-wave-context': cmdSummarizePriorWaveContext(opts); break;
    case 'wave-split': cmdWaveSplit(opts); break;
    case 'verify-completeness': cmdVerifyCompleteness(opts); break;
    case 'detect-resume': cmdDetectResume(opts); break;
    default:
      process.stderr.write(`Error: unknown subcommand "${opts.subcommand}"\n`);
      process.stderr.write('Usage: node execute-state.js <init|wave-start|wave-done|wave-fail|wave-committed|task-done|task-fail|context|read|cleanup|gc|summarize-prior-wave-context|wave-split|verify-completeness|detect-resume> [options]\n');
      process.exit(2);
  }
} catch (e) {
  process.stderr.write(`Unexpected error: ${e.message}\n`);
  process.exit(2);
}
