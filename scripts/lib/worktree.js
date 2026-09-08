'use strict';

/**
 * worktree.js
 * Main-worktree detection helpers — shared by config.js and state.js.
 *
 * Zero npm dependencies — Node.js built-ins only.
 * Must NOT import ./config or ./state (prevents circular dependency).
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the absolute path of the main (primary) worktree by parsing
 * `git worktree list --porcelain`.
 *
 * @param {string} [cwd=process.cwd()] Working directory for the git command.
 * @returns {string} Absolute path to the main worktree.
 * @throws {Error} When git fails or the output cannot be parsed.
 */
function resolveMainWorktree(cwd) {
  const workingDir = cwd || process.cwd();
  let out;
  try {
    out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: workingDir,
      encoding: 'utf8',
    });
  } catch (err) {
    throw new Error(
      `Could not determine main worktree (git worktree list failed in ${workingDir}): ${err.message}`
    );
  }

  if (!out) {
    throw new Error(`Could not determine main worktree (git worktree list returned empty in ${workingDir})`);
  }

  // The first "worktree <path>" entry is always the main worktree.
  const match = out.match(/^worktree (.+)$/m);
  if (!match) {
    throw new Error(`Could not parse main worktree path from git worktree list output in ${workingDir}`);
  }

  return match[1].trim();
}

/**
 * Same as resolveMainWorktree, but never throws.
 *
 * On failure: writes a warning to stderr ONLY when SDLC_DEBUG is set, then
 * returns `cwd` as the fallback. Silent by default to avoid polluting
 * prepare-script output in non-git fixtures and first-time setup runs.
 *
 * @param {string} [cwd=process.cwd()] Working directory for the git command.
 * @returns {string} Main worktree path, or `cwd` on failure.
 */
function resolveMainWorktreeSafe(cwd) {
  const workingDir = cwd || process.cwd();
  try {
    return resolveMainWorktree(workingDir);
  } catch (_) {
    if (process.env.SDLC_DEBUG) {
      process.stderr.write(
        `[sdlc] could not resolve main worktree from cwd ${workingDir}; using cwd as fallback\n`
      );
    }
    return workingDir;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  resolveMainWorktree,
  resolveMainWorktreeSafe,
};
