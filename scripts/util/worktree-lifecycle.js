#!/usr/bin/env node
/**
 * worktree-lifecycle.js
 * Shared git-worktree resolve/remove helper for the ship-sdlc and
 * execute-plan-sdlc skills.
 *
 * Consolidates three previously-duplicated prose sites into one script:
 *   - ship-sdlc cleanup (`git worktree remove <path>` from the main worktree)
 *   - ship-sdlc re-entry on resume (match the resume branch against
 *     `git worktree list --porcelain`, `cd` into the matching path)
 *   - execute-plan-sdlc cleanup (`git worktree remove <path>` from the main
 *     worktree, skipped when invoked from ship-sdlc)
 *
 * Usage:
 *   node worktree-lifecycle.js resolve --branch <name>
 *   node worktree-lifecycle.js remove  --path <worktree-path>
 *
 * Output (stdout, single JSON line):
 *   resolve, match found:  {"found":true,"path":"...","mainWorktree":"...","branch":"...","exists":true,"matchedBy":"branch"|"cwd"}
 *   resolve, no match:     {"found":false,"mainWorktree":"..."}
 *   remove, success:       {"removed":true,"path":"..."}
 *   either, error:         {"error":"<message>","mainWorktree":null,...}  (mainWorktree is null when it could not be resolved; plus any other fields already resolved)
 *
 * Exit codes:
 *   0 = success
 *   1 = user-facing error (missing argument, git failure, main-worktree guard)
 *   2 = unknown subcommand / unexpected crash
 *
 * `remove` refuses to target the resolved main worktree path — the pipeline
 * must never delete the primary checkout.
 *
 * Zero npm dependencies — Node.js built-ins only.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');
const { resolveMainWorktree } = require(path.join(LIB, 'worktree'));
const { writeJsonLine } = require(path.join(LIB, 'output'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default `spawnFn` — runs a git subcommand and returns `{status, stdout, stderr}`.
 * Overridable via `opts.spawnFn` so tests never need a real worktree.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function defaultSpawn(cmd, args, opts) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Default `toplevelFn` — runs `git rev-parse --show-toplevel` in `cwd` and
 * returns the trimmed path, or `null` when the command fails (e.g. `cwd` is
 * not inside a git working tree). Overridable via `opts.toplevelFn`.
 * @param {string} cwd
 * @returns {string|null}
 */
function defaultToplevel(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim() || null;
}

/**
 * Parse `git worktree list --porcelain` output into an array of entries:
 * `{path, head, branch, bare}`. `branch` is stripped of the `refs/heads/`
 * prefix; entries without a `branch` line (detached HEAD, bare) omit it.
 * @param {string} output
 * @returns {Array<{path: string, head?: string, branch?: string, bare?: boolean}>}
 */
function parseWorktreeList(output) {
  const entries = [];
  let current = null;

  for (const line of (output || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('HEAD ')) {
      if (current) current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      if (current) current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'bare') {
      if (current) current.bare = true;
    } else if (line === '') {
      if (current && current.path) entries.push(current);
      current = null;
    }
  }
  if (current && current.path) entries.push(current);

  return entries;
}

/**
 * Resolve the worktree path for a given branch by parsing
 * `git worktree list --porcelain`. Reuses `resolveMainWorktree()` from
 * `scripts/lib/worktree.js` rather than reimplementing main-worktree
 * detection.
 *
 * When `branch` matches no entry, falls back to matching `cwd`'s toplevel
 * (`git rev-parse --show-toplevel` run in `cwd`) against *linked* entry
 * paths (the main worktree's own entry is excluded — being in the main
 * worktree is not "finding" a linked worktree) — this covers resuming
 * inside a linked worktree whose branch name isn't otherwise known to the
 * caller. A cwd-matched result carries `matchedBy: 'cwd'` and the entry's
 * own `branch`; a branch-matched result carries `matchedBy: 'branch'`.
 *
 * @param {string} branch
 * @param {object} [opts]
 * @param {Function} [opts.spawnFn]  Injectable `(cmd, args, opts) => {status, stdout, stderr}`.
 * @param {string}   [opts.cwd]      Working directory for git commands (default `process.cwd()`).
 * @param {Function} [opts.resolveMainWorktreeFn]  Injectable replacement for `resolveMainWorktree`.
 * @param {Function} [opts.existsFn]  Injectable `(path) => boolean`, default `fs.existsSync`.
 * @param {Function} [opts.toplevelFn]  Injectable `(cwd) => string|null`, default runs `git rev-parse --show-toplevel`.
 * @returns {{found: boolean, path?: string, mainWorktree: string|null, branch?: string, exists?: boolean, matchedBy?: 'branch'|'cwd', error?: string}}
 */
function resolveWorktree(branch, opts = {}) {
  const spawnFn = opts.spawnFn || defaultSpawn;
  const cwd = opts.cwd || process.cwd();
  const resolveMain = opts.resolveMainWorktreeFn || resolveMainWorktree;
  const existsFn = opts.existsFn || fs.existsSync;
  const toplevelFn = opts.toplevelFn || defaultToplevel;

  let mainWorktree;
  try {
    mainWorktree = resolveMain(cwd);
  } catch (err) {
    return { found: false, mainWorktree: null, error: `Could not resolve main worktree: ${err.message}` };
  }

  const result = spawnFn('git', ['worktree', 'list', '--porcelain'], { cwd: mainWorktree });
  if (result.status !== 0) {
    return { found: false, mainWorktree, error: `git worktree list failed: ${result.stderr.trim()}` };
  }

  const entries = parseWorktreeList(result.stdout);
  const match = entries.find((e) => e.branch === branch);

  if (match) {
    return { found: true, path: match.path, mainWorktree, branch, exists: existsFn(match.path), matchedBy: 'branch' };
  }

  const toplevel = toplevelFn(cwd);
  if (toplevel && path.resolve(toplevel) !== path.resolve(mainWorktree)) {
    const cwdMatch = entries.find((e) => path.resolve(e.path) === path.resolve(toplevel));
    if (cwdMatch) {
      return { found: true, path: cwdMatch.path, mainWorktree, branch: cwdMatch.branch, exists: true, matchedBy: 'cwd' };
    }
  }

  return { found: false, mainWorktree };
}

/**
 * Remove a worktree via `git worktree remove`, refusing to ever target the
 * resolved main worktree path.
 *
 * @param {string} targetPath
 * @param {object} [opts]
 * @param {Function} [opts.spawnFn]  Injectable `(cmd, args, opts) => {status, stdout, stderr}`.
 * @param {string}   [opts.cwd]      Working directory for git commands (default `process.cwd()`).
 * @param {Function} [opts.resolveMainWorktreeFn]  Injectable replacement for `resolveMainWorktree`.
 * @returns {{removed: boolean, path?: string, error?: string}}
 */
function removeWorktree(targetPath, opts = {}) {
  const spawnFn = opts.spawnFn || defaultSpawn;
  const cwd = opts.cwd || process.cwd();
  const resolveMain = opts.resolveMainWorktreeFn || resolveMainWorktree;

  let mainWorktree;
  try {
    mainWorktree = resolveMain(cwd);
  } catch (err) {
    return { error: `Could not resolve main worktree: ${err.message}` };
  }

  if (path.resolve(targetPath) === path.resolve(mainWorktree)) {
    return { error: 'refusing to remove the main worktree' };
  }

  const result = spawnFn('git', ['worktree', 'remove', targetPath], { cwd: mainWorktree });
  if (result.status !== 0) {
    return { error: `git worktree remove failed: ${result.stderr.trim()}` };
  }

  return { removed: true, path: targetPath };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Manual argv parser — mirrors the `parseArgs` loop convention used across
 * `scripts/state/execute.js` and sibling `scripts/util/*.js` CLIs.
 * @param {string[]} argv  Full argv (`process.argv` shape).
 * @returns {{subcommand: string|null, branch?: string, path?: string}}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { subcommand: args[0] || null };

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--branch' && args[i + 1]) {
      result.branch = args[++i];
    } else if (a === '--path' && args[i + 1]) {
      result.path = args[++i];
    }
  }

  return result;
}

function cmdResolve(opts) {
  if (!opts.branch) {
    writeJsonLine({ error: 'Missing required argument: --branch <name>' }, { exitCode: 1 });
    return;
  }
  const result = resolveWorktree(opts.branch);
  writeJsonLine(result, { exitCode: result.error ? 1 : 0 });
}

function cmdRemove(opts) {
  if (!opts.path) {
    writeJsonLine({ error: 'Missing required argument: --path <worktree-path>' }, { exitCode: 1 });
    return;
  }
  const result = removeWorktree(opts.path);
  writeJsonLine(result, { exitCode: result.error ? 1 : 0 });
}

/**
 * Subcommand dispatch — mirrors the `switch (opts.subcommand)` pattern at
 * the bottom of `scripts/state/execute.js`.
 * @param {string[]} argv  Full argv (`process.argv` shape).
 */
function main(argv) {
  const opts = parseArgs(argv);

  switch (opts.subcommand) {
    case 'resolve': cmdResolve(opts); break;
    case 'remove':  cmdRemove(opts);  break;
    default:
      process.stderr.write(`Error: unknown subcommand "${opts.subcommand}"\n`);
      process.stderr.write('Usage: node worktree-lifecycle.js <resolve|remove> [options]\n');
      process.exit(2);
  }
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: `Unexpected error: ${err.message}` }) + '\n');
    process.exit(2);
  }
}

module.exports = { resolveWorktree, removeWorktree, parseWorktreeList, parseArgs, main };
