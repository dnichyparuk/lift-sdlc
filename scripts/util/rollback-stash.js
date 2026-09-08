#!/usr/bin/env node
/**
 * rollback-stash.js — execution-failure rollback helper.
 *
 * Node port of the inlined shell sequence in
 * skills/execute-plan-sdlc/resources/recovering-from-failures.md's
 * "Rollback Strategy" section:
 *
 *   git stash push -m "failed-wave-N-$(date +%Y%m%d-%H%M%S)"
 *   git status
 *   git stash list
 *   ...
 *   git stash drop stash@{0}
 *
 * plus the single-file revert used by the "Unauthorized file modification"
 * recovery strategy (`git checkout -- <file>`).
 *
 * Usage:
 *   node rollback-stash.js stash [--label <text>]
 *   node rollback-stash.js stash --drop <ref>
 *   node rollback-stash.js revert-file --path <file>
 *
 * `stash` (no --drop) pushes a stash with a timestamped message, then
 * confirms the result via `git status` + `git stash list` and branches
 * three ways:
 *   {"status": "nothing_to_stash"}                    — clean tree, nothing pushed
 *   {"status": "stashed", "ref": "stash@{0}"}          — pushed and confirmed
 *   {"status": "failed", "message": "<diagnostic>"}    — push or confirmation failed
 *
 * `stash --drop <ref>` drops a previously-created stash entry. This never
 * happens automatically — dropping always requires an explicit second call
 * with the ref the first call returned, after the caller has confirmed the
 * recovery succeeded:
 *   {"status": "dropped", "ref": "stash@{0}"}
 *   {"status": "failed", "ref": "stash@{0}", "message": "<diagnostic>"}
 *
 * `revert-file --path <file>` wraps a bare single-file `git checkout --
 * <file>`:
 *   {"status": "reverted", "path": "<file>"}
 *   {"status": "failed", "path": "<file>", "message": "<diagnostic>"}
 *
 * Output: one JSON line via writeJsonLine() (lib/output.js). Exit code is 0
 * for every non-"failed" status, 1 when status is "failed".
 *
 * `spawnFn` is injectable on every exported core function so tests can run
 * without a real git repo.
 *
 * Uses only Node.js built-in modules. No npm install required.
 */
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');
const { writeJsonLine } = require(path.join(LIB, 'output'));

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function getArg(args, name) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

/**
 * @param {string[]} argv  Full argv (process.argv shape).
 * @returns {{command: string|null, drop: string|null, label: string|null, path: string|null}}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    command: args[0] || null,
    drop: getArg(args, '--drop'),
    label: getArg(args, '--label'),
    path: getArg(args, '--path'),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command and normalize its result. Mirrors
 * verify-tag-ancestry.js's spawnSync result normalization
 * (verify-tag-ancestry.js:41-69).
 */
function run(spawnFn, cmdArgs, cwd) {
  const result = spawnFn('git', cmdArgs, { cwd, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

// ---------------------------------------------------------------------------
// Core (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Stash all working-tree changes with a timestamped message, then confirm
 * via `git status` + `git stash list`. Never drops a stash — dropping is a
 * separate, explicit call (see `dropStash`).
 *
 * @param {{spawnFn?: Function, cwd?: string, label?: string}} [opts]
 * @returns {{status: 'nothing_to_stash'} | {status: 'stashed', ref: string} | {status: 'failed', message: string}}
 */
function runStash({ spawnFn = spawnSync, cwd = process.cwd(), label = 'rollback' } = {}) {
  const message = `${label}-${new Date().toISOString()}`;

  const pushResult = run(spawnFn, ['stash', 'push', '-m', message], cwd);
  if (pushResult.status !== 0) {
    return { status: 'failed', message: pushResult.stderr || pushResult.stdout || 'git stash push failed' };
  }
  if (/no local changes to save/i.test(pushResult.stdout)) {
    return { status: 'nothing_to_stash' };
  }

  // Confirm via git status + git stash list, per the acceptance criteria.
  const statusResult = run(spawnFn, ['status', '--porcelain'], cwd);
  const listResult   = run(spawnFn, ['stash', 'list'], cwd);

  if (statusResult.status !== 0 || listResult.status !== 0) {
    return {
      status: 'failed',
      message: `stash push reported success but confirmation failed: ${statusResult.stderr || listResult.stderr || 'unknown error'}`,
    };
  }

  const topEntry = (listResult.stdout.split('\n')[0] || '');
  const refMatch = topEntry.match(/^(stash@\{\d+\})/);
  if (!refMatch) {
    return {
      status: 'failed',
      message: `stash push reported success but git stash list has no matching entry (got: ${JSON.stringify(listResult.stdout)})`,
    };
  }

  return { status: 'stashed', ref: refMatch[1] };
}

/**
 * Drop a previously-created stash entry. Only ever called explicitly by the
 * caller with the ref `runStash` returned, after the caller has confirmed
 * the recovery succeeded — dropping never happens automatically.
 *
 * @param {string} ref  Stash ref, e.g. "stash@{0}".
 * @param {{spawnFn?: Function, cwd?: string}} [opts]
 * @returns {{status: 'dropped', ref: string} | {status: 'failed', ref: string, message: string}}
 */
function dropStash(ref, { spawnFn = spawnSync, cwd = process.cwd() } = {}) {
  const result = run(spawnFn, ['stash', 'drop', ref], cwd);
  if (result.status !== 0) {
    return { status: 'failed', ref, message: result.stderr || result.stdout || 'git stash drop failed' };
  }
  return { status: 'dropped', ref };
}

/**
 * Revert a single file to its last-committed state (`git checkout -- <path>`).
 *
 * @param {string} filePath
 * @param {{spawnFn?: Function, cwd?: string}} [opts]
 * @returns {{status: 'reverted', path: string} | {status: 'failed', path: string, message: string}}
 */
function revertFile(filePath, { spawnFn = spawnSync, cwd = process.cwd() } = {}) {
  const result = run(spawnFn, ['checkout', '--', filePath], cwd);
  if (result.status !== 0) {
    return { status: 'failed', path: filePath, message: result.stderr || result.stdout || 'git checkout -- failed' };
  }
  return { status: 'reverted', path: filePath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function usage() {
  return (
    'Usage:\n' +
    '  rollback-stash.js stash [--label <text>]\n' +
    '  rollback-stash.js stash --drop <ref>\n' +
    '  rollback-stash.js revert-file --path <file>\n'
  );
}

function main(argv) {
  const { command, drop, label, path: filePath } = parseArgs(argv);

  let result;
  if (command === 'stash' && drop) {
    result = dropStash(drop);
  } else if (command === 'stash') {
    result = runStash(label ? { label } : {});
  } else if (command === 'revert-file') {
    if (!filePath) {
      process.stderr.write(usage());
      process.exit(1);
    }
    result = revertFile(filePath);
  } else {
    process.stderr.write(usage());
    process.exit(1);
  }

  writeJsonLine(result, { exitCode: result.status === 'failed' ? 1 : 0 });
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { parseArgs, runStash, dropStash, revertFile, main };
