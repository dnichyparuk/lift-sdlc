#!/usr/bin/env node
/**
 * rebase-onto-base.js — rebase the current branch onto a base branch, with a
 * safe conflict fallback.
 *
 * Usage:
 *   node rebase-onto-base.js --base <branch> [--remote <name>]
 *
 * Behavior:
 *   1. `git fetch <remote> <base>` (remote defaults to "origin") then
 *      `git merge-base --is-ancestor <remote>/<base> HEAD` to check whether
 *      the current branch already contains the base tip — no rebase needed.
 *   2. Otherwise attempts `git rebase <remote>/<base>`.
 *   3. On conflict, collects the conflicting file paths and runs
 *      `git rebase --abort` so the repo is never left mid-rebase, then
 *      reports the conflict.
 *
 * Output (stdout, one JSON line via writeJsonLine()):
 *   {"status": "up_to_date"}
 *   {"status": "clean", "sha": "<new-head-sha>"}
 *   {"status": "conflicts", "files": ["path/a.js", "path/b.js"]}
 *   {"status": "fetch_failed", "remote": "origin", "base": "main", "error": "<stderr>"}
 *
 * Exit codes:
 *   0 = always, for all four outcomes above — the caller (SKILL.md) branches
 *       on `status`, not exit code, since a conflict or fetch failure is a
 *       normal fallback outcome and not a script "crash".
 *   1 = usage error (missing/unrecognized --base)
 *
 * Runs in the current cwd (not `resolveSdlcRoot()`) so the rebase applies to
 * the active worktree/branch.
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
 * @returns {{base: string|null, remote: string}}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  return { base: getArg(args, '--base'), remote: getArg(args, '--remote') || 'origin' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command and normalize its result. Mirrors
 * verify-tag-ancestry.js's spawnSync result normalization.
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
 * Rebase the current branch onto `<remote>/<base>`, falling back to an
 * aborted rebase with a conflict report when the rebase does not apply
 * cleanly.
 *
 * @param {string} base  Base branch name (e.g. "main").
 * @param {{spawnFn?: Function, cwd?: string, remote?: string}} [opts]
 * @returns {{status: 'up_to_date'} | {status: 'clean', sha: string} | {status: 'conflicts', files: string[]} | {status: 'fetch_failed', remote: string, base: string, error: string}}
 */
function resolveRebaseOntoBase(base, { spawnFn = spawnSync, cwd = process.cwd(), remote = 'origin' } = {}) {
  const baseRef = `${remote}/${base}`;

  const fetchResult = run(spawnFn, ['fetch', remote, base], cwd);
  if (fetchResult.status !== 0) {
    return { status: 'fetch_failed', remote, base, error: fetchResult.stderr };
  }

  const ancestorCheck = run(spawnFn, ['merge-base', '--is-ancestor', baseRef, 'HEAD'], cwd);
  if (ancestorCheck.status === 0) {
    return { status: 'up_to_date' };
  }

  const rebaseResult = run(spawnFn, ['rebase', baseRef], cwd);
  if (rebaseResult.status === 0) {
    const sha = run(spawnFn, ['rev-parse', 'HEAD'], cwd).stdout;
    return { status: 'clean', sha };
  }

  const conflictCheck = run(spawnFn, ['diff', '--name-only', '--diff-filter=U'], cwd);
  const files = conflictCheck.stdout ? conflictCheck.stdout.split('\n').filter(Boolean) : [];

  // Never leave the repo mid-rebase.
  run(spawnFn, ['rebase', '--abort'], cwd);

  return { status: 'conflicts', files };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { base, remote } = parseArgs(argv);
  if (!base) {
    process.stderr.write('Usage: rebase-onto-base.js --base <branch>\n');
    process.exit(1);
  }

  const result = resolveRebaseOntoBase(base, { remote });
  writeJsonLine(result);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { parseArgs, resolveRebaseOntoBase, main };
