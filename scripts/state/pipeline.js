#!/usr/bin/env node
/**
 * pipeline.js
 * Generic CLI wrapper for managing SDLC pipeline execution state files.
 * Supports any registered pipeline (ship, run-workflow, custom).
 * Delegates all I/O to lib/state.js; zero npm dependencies.
 *
 * Usage:
 *   node pipeline.js [--pipeline <id>] init             --branch <b> --flags <json> [--steps <json>]
 *   node pipeline.js [--pipeline <id>] start            --step <name> [--branch <b>]
 *   node pipeline.js [--pipeline <id>] complete         --step <name> --result <text> [--branch <b>]
 *   node pipeline.js [--pipeline <id>] skip             --step <name> --reason <text> [--branch <b>]
 *   node pipeline.js [--pipeline <id>] fail             --step <name> --error <text> [--branch <b>]
 *   node pipeline.js [--pipeline <id>] suspend          --step <name> [--question <json>] [--branch <b>]
 *   node pipeline.js [--pipeline <id>] resume           --step <name> [--answer <json>] [--branch <b>]
 *   node pipeline.js [--pipeline <id>] decide           --step <name> --text <text> [--branch <b>]
 *   node pipeline.js [--pipeline <id>] defer            --severity <s> --file <f> [--line <n>] --title <t> [--branch <b>]
 *   node pipeline.js [--pipeline <id>] read             [--branch <b>]
 *   node pipeline.js [--pipeline <id>] cleanup          [--branch <b>]                    # legacy alias of cleanup-pipeline (no GC sweep)
 *   node pipeline.js [--pipeline <id>] cleanup-pipeline [--force] [--ttl-days <N>] [--branch <b>]
 *   node pipeline.js [--pipeline <id>] gc               [--ttl-days <N>] [--dry-run]
 *   node pipeline.js [--pipeline <id>] migrate          --from <slug> --to <branch>
 *
 * Exit codes:
 *   0 = success
 *   1 = state file not found (read/cleanup) or step not found / contract violation
 *   2 = unexpected error or invalid args
 */

'use strict';

const path = require('node:path');
const fs   = require('node:fs');
const LIB = path.join(__dirname, '..', 'lib');

const {
  slugifyBranch,
  readState, writeState, initState, deleteState, resolveBranch,
  gcStateFiles, pruneStateFiles, migrateBranchSlug,
  listBranches, readTtlDaysFromConfig,
  registerStatePrefix, getRegisteredPrefixes,
} = require(path.join(LIB, 'state'));

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let subcommand = null;
  const result = { pipeline: 'ship' };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--pipeline' && args[i + 1]) {
      result.pipeline = args[++i];
    } else if (!subcommand && !a.startsWith('-')) {
      subcommand = a;
    } else if (a === '--branch' && args[i + 1]) {
      result.branch = args[++i];
    } else if (a === '--flags' && args[i + 1]) {
      result.flags = args[++i];
    } else if (a === '--steps' && args[i + 1]) {
      result.steps = args[++i];
    } else if (a === '--step' && args[i + 1]) {
      result.step = args[++i];
    } else if (a === '--result' && args[i + 1]) {
      result.result = args[++i];
    } else if (a === '--reason' && args[i + 1]) {
      result.reason = args[++i];
    } else if (a === '--error' && args[i + 1]) {
      result.error = args[++i];
    } else if (a === '--question' && args[i + 1]) {
      result.question = args[++i];
    } else if (a === '--answer' && args[i + 1]) {
      result.answer = args[++i];
    } else if (a === '--text' && args[i + 1]) {
      result.text = args[++i];
    } else if (a === '--severity' && args[i + 1]) {
      result.severity = args[++i];
    } else if (a === '--file' && args[i + 1]) {
      result.file = args[++i];
    } else if (a === '--line' && args[i + 1]) {
      result.line = args[++i];
    } else if (a === '--title' && args[i + 1]) {
      result.title = args[++i];
    } else if (a === '--ttl-days' && args[i + 1]) {
      const val = parseInt(args[++i], 10);
      if (isNaN(val)) { process.stderr.write(`Error: --ttl-days requires a number, got "${args[i]}"\n`); process.exit(2); }
      result.ttlDays = val;
    } else if (a === '--dry-run') {
      result.dryRun = true;
    } else if (a === '--force') {
      result.force = true;
    } else if (a === '--from' && args[i + 1]) {
      result.from = args[++i];
    } else if (a === '--to' && args[i + 1]) {
      result.to = args[++i];
    }
  }

  result.subcommand = subcommand;
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
// Default Step Templates
// ---------------------------------------------------------------------------

const DEFAULT_SHIP_STEPS = [
  { name: 'execute',         status: 'pending' },
  { name: 'commit',          status: 'pending' },
  { name: 'review',          status: 'pending' },
  { name: 'received-review', status: 'pending', condition: 'if critical/high findings' },
  { name: 'commit-fixes',    status: 'pending', condition: 'if received-review made changes' },
  { name: 'version',         status: 'pending' },
  { name: 'pr',              status: 'pending' },
];

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

function cmdInit(opts) {
  if (!opts.branch) {
    process.stderr.write('Error: --branch is required for init\n');
    process.exit(2);
  }

  registerStatePrefix(opts.pipeline);

  let flags;
  try {
    flags = opts.flags ? JSON.parse(opts.flags) : {};
  } catch (e) {
    process.stderr.write(`Error: --flags is not valid JSON: ${e.message}\n`);
    process.exit(2);
  }

  let steps = DEFAULT_SHIP_STEPS;
  if (opts.steps) {
    try {
      const parsedSteps = JSON.parse(opts.steps);
      if (Array.isArray(parsedSteps)) {
        steps = parsedSteps.map(s => {
          if (typeof s === 'string') return { name: s, status: 'pending' };
          return {
            name: s.name || s.id,
            status: s.status || 'pending',
            condition: s.condition,
          };
        });
      }
    } catch (e) {
      process.stderr.write(`Error: --steps is not valid JSON: ${e.message}\n`);
      process.exit(2);
    }
  }

  const data = {
    pipeline: opts.pipeline,
    version: 1,
    startedAt: new Date().toISOString(),
    branch: opts.branch,
    flags,
    steps,
    decisions: [],
    deferredFindings: [],
  };

  try {
    const branchSlug = slugifyBranch(opts.branch);
    const prunedOrphans = pruneStateFiles(opts.pipeline, branchSlug);

    const filePath = initState(opts.pipeline, opts.branch, data);
    process.stdout.write(JSON.stringify({ filePath, prunedOrphans }) + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(2);
  }
}

function findActiveStep(opts) {
  if (!opts.step) {
    process.stderr.write('Error: --step is required\n');
    process.exit(2);
  }

  registerStatePrefix(opts.pipeline);
  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState(opts.pipeline, slug);
  if (!found) {
    process.stderr.write(`Error: no state file found for pipeline "${opts.pipeline}" on branch "${branch}"\n`);
    process.exit(1);
  }

  const { data, filePath } = found;
  const step = (data.steps || []).find(s => s.name === opts.step || s.id === opts.step);
  if (!step) {
    process.stderr.write(`Error: step "${opts.step}" not found in state file\n`);
    process.exit(1);
  }

  return { step, data, filePath, branch, slug };
}

function cmdStart(opts) {
  const { step, data, filePath } = findActiveStep(opts);
  step.status = 'in_progress';
  step.startedAt = new Date().toISOString();
  writeState(filePath, data);
  process.exit(0);
}

function cmdComplete(opts) {
  const { step, data, filePath } = findActiveStep(opts);
  step.status = 'completed';
  step.completedAt = new Date().toISOString();
  if (opts.result) step.result = opts.result;
  writeState(filePath, data);
  process.exit(0);
}

function cmdSkip(opts) {
  const { step, data, filePath } = findActiveStep(opts);
  step.status = 'skipped';
  step.completedAt = new Date().toISOString();
  if (opts.reason) step.skipReason = opts.reason;
  writeState(filePath, data);
  process.exit(0);
}

function cmdFail(opts) {
  const { step, data, filePath } = findActiveStep(opts);
  step.status = 'failed';
  step.completedAt = new Date().toISOString();
  if (opts.error) step.error = opts.error;
  writeState(filePath, data);
  process.exit(0);
}

function cmdSuspend(opts) {
  const { step, data, filePath } = findActiveStep(opts);
  step.status = 'needs_input';
  step.suspendedAt = new Date().toISOString();
  if (opts.question) {
    try {
      step.question = JSON.parse(opts.question);
    } catch (_) {
      step.question = opts.question;
    }
  }
  writeState(filePath, data);
  process.exit(0);
}

function cmdResume(opts) {
  const { step, data, filePath } = findActiveStep(opts);
  step.status = 'in_progress';
  step.resumedAt = new Date().toISOString();
  if (opts.answer) {
    try {
      step.answer = JSON.parse(opts.answer);
    } catch (_) {
      step.answer = opts.answer;
    }
  }
  writeState(filePath, data);
  process.exit(0);
}

function cmdDecide(opts) {
  if (!opts.step) {
    process.stderr.write('Error: --step is required\n');
    process.exit(2);
  }
  if (!opts.text) {
    process.stderr.write('Error: --text is required\n');
    process.exit(2);
  }

  registerStatePrefix(opts.pipeline);
  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState(opts.pipeline, slug);
  if (!found) {
    process.stderr.write(`Error: no state file found for pipeline "${opts.pipeline}" on branch "${branch}"\n`);
    process.exit(1);
  }

  const { data, filePath } = found;
  if (!Array.isArray(data.decisions)) data.decisions = [];
  data.decisions.push({
    step: opts.step,
    text: opts.text,
    timestamp: new Date().toISOString(),
  });

  writeState(filePath, data);
  process.exit(0);
}

function cmdDefer(opts) {
  if (!opts.severity || !opts.file || !opts.title) {
    process.stderr.write('Error: --severity, --file, and --title are required for defer\n');
    process.exit(2);
  }

  registerStatePrefix(opts.pipeline);
  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState(opts.pipeline, slug);
  if (!found) {
    process.stderr.write(`Error: no state file found for pipeline "${opts.pipeline}" on branch "${branch}"\n`);
    process.exit(1);
  }

  const { data, filePath } = found;
  if (!Array.isArray(data.deferredFindings)) data.deferredFindings = [];
  data.deferredFindings.push({
    severity: opts.severity,
    file: opts.file,
    line: opts.line ? parseInt(opts.line, 10) : undefined,
    title: opts.title,
    timestamp: new Date().toISOString(),
  });

  writeState(filePath, data);
  process.exit(0);
}

function cmdRead(opts) {
  registerStatePrefix(opts.pipeline);
  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState(opts.pipeline, slug);
  if (!found) {
    process.stderr.write(`Error: no state file found for pipeline "${opts.pipeline}" on branch "${branch}"\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(found.data, null, 2) + '\n');
  process.exit(0);
}

function validatePipelineContract(stateData) {
  const violations = [];
  for (const step of (stateData.steps || [])) {
    if (step.status === 'pending' || step.status === 'in_progress' || step.status === 'needs_input') {
      violations.push({ step: step.name || step.id, status: step.status });
    }
  }
  return {
    valid: violations.length === 0,
    violations: violations.map(v => ({
      step: v.step,
      actualStatus: v.status,
      message: `Step "${v.step}" has status "${v.status}" — expected completed, skipped, or failed`,
    })),
  };
}

function cmdCleanup(opts) {
  registerStatePrefix(opts.pipeline);
  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState(opts.pipeline, slug);
  if (!found) {
    process.exit(0);
  }

  const contract = validatePipelineContract(found.data);
  if (!contract.valid) {
    process.stdout.write(JSON.stringify({ valid: false, violations: contract.violations }, null, 2) + '\n');
    process.stderr.write(`Pipeline contract violation: ${contract.violations.length} step(s) not in terminal state. State file preserved.\n`);
    process.exit(1);
  }

  deleteState(found.filePath);
  process.stdout.write(JSON.stringify({ valid: true, cleaned: true }, null, 2) + '\n');
  process.exit(0);
}

function cmdCleanupPipeline(opts) {
  registerStatePrefix(opts.pipeline);
  const branch = resolveBranchOrExit(opts.branch);
  const slug = slugifyBranch(branch);
  const found = readState(opts.pipeline, slug);

  const ttlDays = (typeof opts.ttlDays === 'number') ? opts.ttlDays : readTtlDaysFromConfig();
  const knownBranches = listBranches();

  const report = {
    currentRun: { valid: true, cleaned: false },
    gc: {},
    force: !!opts.force,
    ttlDays,
  };

  if (opts.force) {
    report.currentRun = { valid: null, cleaned: false, preservedReason: 'force' };
  } else if (!found) {
    report.currentRun = { valid: true, cleaned: false, reason: 'no-state-file' };
  } else {
    const contract = validatePipelineContract(found.data);
    if (!contract.valid) {
      report.currentRun = { valid: false, cleaned: false, violations: contract.violations };
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.stderr.write(`Pipeline contract violation: ${contract.violations.length} step(s) not in terminal state. State file preserved.\n`);
      process.exit(1);
    }
    deleteState(found.filePath);
    report.currentRun = { valid: true, cleaned: true };
  }

  // GC sweep across all registered prefixes
  const prefixes = getRegisteredPrefixes();
  for (const prefix of prefixes) {
    report.gc[prefix] = gcStateFiles({ prefix, ttlDays, knownBranches });
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(0);
}

function cmdGc(opts) {
  const ttlDays = (typeof opts.ttlDays === 'number') ? opts.ttlDays : readTtlDaysFromConfig();
  const knownBranches = listBranches();
  const prefixes = getRegisteredPrefixes();

  if (opts.dryRun) {
    const { resolveStateDir, parseStateFilename } = require(path.join(LIB, 'state'));
    const stateDir = resolveStateDir();
    const liveSlugs = new Set(knownBranches.map(slugifyBranch));
    const now = Date.now();
    const ttlMs = ttlDays * 86400000;

    const out = {};
    for (const p of prefixes) {
      out[p] = { wouldDelete: [], wouldKeep: [] };
    }

    let entries = [];
    try { entries = fs.readdirSync(stateDir); } catch (_) { /* empty */ }

    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const parsed = parseStateFilename(name);
      if (!parsed) continue;
      if (!out[parsed.prefix]) out[parsed.prefix] = { wouldDelete: [], wouldKeep: [] };
      const bucket = out[parsed.prefix];
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

  const out = { ttlDays };
  for (const prefix of prefixes) {
    out[prefix] = gcStateFiles({ prefix, ttlDays, knownBranches });
  }

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

function cmdMigrate(opts) {
  if (!opts.from || !opts.to) {
    process.stderr.write('Error: --from <slug> and --to <branch> are required for migrate\n');
    process.exit(2);
  }

  registerStatePrefix(opts.pipeline);
  const result = migrateBranchSlug({ prefix: opts.pipeline, fromSlug: opts.from, toBranch: opts.to });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.migrated ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  const opts = parseArgs(process.argv);

  switch (opts.subcommand) {
    case 'init':     cmdInit(opts);     break;
    case 'start':    cmdStart(opts);    break;
    case 'complete': cmdComplete(opts); break;
    case 'skip':     cmdSkip(opts);     break;
    case 'fail':     cmdFail(opts);     break;
    case 'suspend':  cmdSuspend(opts);  break;
    case 'resume':   cmdResume(opts);   break;
    case 'decide':   cmdDecide(opts);   break;
    case 'defer':    cmdDefer(opts);    break;
    case 'read':     cmdRead(opts);     break;
    case 'cleanup':           cmdCleanup(opts);          break;
    case 'cleanup-pipeline':  cmdCleanupPipeline(opts);  break;
    case 'gc':                cmdGc(opts);               break;
    case 'migrate':           cmdMigrate(opts);          break;
    default:
      process.stderr.write(`Error: unknown subcommand "${opts.subcommand}"\n`);
      process.stderr.write('Usage: node pipeline.js [--pipeline <id>] <init|start|complete|skip|fail|suspend|resume|decide|defer|read|cleanup|cleanup-pipeline|gc|migrate> [options]\n');
      process.exit(2);
  }
} catch (e) {
  process.stderr.write(`Unexpected error: ${e.message}\n`);
  process.exit(2);
}
