#!/usr/bin/env node
/**
 * learn-status.js
 *
 * Fast (<50ms), read-only status checker for pending learnings changesets.
 * Inspects .sdlc/learnings/pending/, applies negative cache filtering against
 * config.rejected_guardrails, groups by signature, evaluates against
 * recurrenceThreshold, and outputs a JSON status line to stdout.
 *
 * Usage:
 *   node learn-status.js [--cwd <dir>]
 *
 * Output (stdout):
 *   {"eligibleCount":1,"waitingCount":2,"eligibleSignatures":["auth-sql"],"waitingSignatures":["lint-err"],"threshold":3}
 *
 * Exit codes:
 *   0 = success (JSON emitted on stdout)
 *   2 = unexpected script crash
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const { resolveSdlcRoot, readSection } = require(path.join(LIB, 'config'));
const { writeJsonLine } = require(path.join(LIB, 'output'));
const {
  parsePendingFile,
  filterRejected,
  groupBySignature,
  selectEligible,
  DEFAULT_THRESHOLD,
} = require(path.join(LIB, 'learnings'));

const PENDING_REL_PATH = path.join('.sdlc', 'learnings', 'pending');

function parseArgs(argv) {
  let cwd = null;
  let showHelp = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      showHelp = true;
    } else if (arg === '--cwd') {
      cwd = argv[++i];
    }
  }

  return { cwd, showHelp };
}

function getLearnStatus(deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const fsImpl = deps.fs || fs;
  const projectRoot = deps.projectRoot || resolveSdlcRoot({ cwd }) || cwd;

  const rejected = deps.rejectedGuardrails !== undefined
    ? deps.rejectedGuardrails
    : (readSection(projectRoot, 'rejected_guardrails') || []);

  const learnConfig = deps.learnConfig !== undefined
    ? deps.learnConfig
    : readSection(projectRoot, 'learn');

  const threshold = (typeof learnConfig?.recurrenceThreshold === 'number' && learnConfig.recurrenceThreshold >= 1)
    ? learnConfig.recurrenceThreshold
    : DEFAULT_THRESHOLD;

  const pendingDir = path.join(projectRoot, PENDING_REL_PATH);
  const parsed = [];

  if (fsImpl.existsSync(pendingDir)) {
    const dirents = fsImpl.readdirSync(pendingDir, { withFileTypes: true });
    for (const ent of dirents) {
      const isFile = typeof ent.isFile === 'function' ? ent.isFile() : true;
      const name = ent.name || ent;
      if (!isFile || typeof name !== 'string' || name.startsWith('.')) continue;

      const fullPath = path.join(pendingDir, name);
      try {
        const content = fsImpl.readFileSync(fullPath, 'utf8');
        const res = parsePendingFile(content, fullPath);
        if (res.valid) {
          parsed.push(res);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  const filtered = filterRejected(parsed, rejected);
  const groups = groupBySignature(filtered);
  const { eligible, waiting } = selectEligible(groups, threshold);

  return {
    eligibleCount: eligible.length,
    waitingCount: waiting.length,
    eligibleSignatures: eligible.map((e) => e.signature),
    waitingSignatures: waiting.map((w) => w.signature),
    waitingDetails: waiting,
    threshold,
  };
}

async function runLearnStatus(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const exit = deps.exit || process.exit;
  const { cwd, showHelp } = parseArgs(argv);

  if (showHelp) {
    stdout.write('Usage: node learn-status.js [--cwd <dir>]\n');
    return exit(0);
  }

  const status = getLearnStatus({ ...deps, cwd: cwd || deps.cwd });
  if (deps.writeJsonLine) {
    deps.writeJsonLine(status);
  } else {
    writeJsonLine(status);
  }
}

async function main() {
  try {
    await runLearnStatus(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Unexpected error: ${err.stack || err.message}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getLearnStatus,
  runLearnStatus,
  parseArgs,
};
