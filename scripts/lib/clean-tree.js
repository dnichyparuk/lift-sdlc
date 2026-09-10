'use strict';
/**
 * @file lib/clean-tree.js
 * @description Shared clean-tree precondition logic for the self-learning
 *   scripts (`learn-prepare.js`, `learn-reject.js`). Both scripts require an
 *   identical two-part clean-tree check (tracked-file modifications, and
 *   untracked entries outside `.sdlc/learnings/pending/`) plus the same
 *   `.sdlc/config.json`-must-be-tracked guard before they touch git state.
 *   Extracted here (code-quality-review finding, self-learning-loop review)
 *   so a future fix to either check does not have to be manually applied in
 *   two places — the two copies had already drifted once (learn-apply.js's
 *   `restoreConfig` vs learn-reject.js's).
 *
 *   Uses `spawnSync` with argv arrays (never a shell string) — same
 *   no-shell-injection posture as the rest of the self-learning scripts.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Run a git command via argv array (no shell). */
function git(projectRoot, args) {
  return spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
}

/** Best-effort human-readable failure reason from a spawnSync result. */
function stderrOf(result) {
  if (!result) return '(no result)';
  if (result.error) return result.error.message;
  return result.stderr ? result.stderr.trim() : `exit ${result.status}`;
}

/** Strip git's C-style quoting from a porcelain path when present. */
function dequote(p) {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p);
    } catch (_) {
      return p.slice(1, -1);
    }
  }
  return p;
}

/**
 * Two-part clean-tree precondition:
 *   (a) no tracked-file modifications
 *   (b) no untracked entries outside `pendingPrefix`
 *
 * @param {string} projectRoot
 * @param {object} opts
 * @param {string} opts.pendingDir     e.g. '.sdlc/learnings/pending' — used in the message only.
 * @param {string} opts.pendingPrefix  e.g. '.sdlc/learnings/pending/' — untracked entries under
 *   this prefix are exempt.
 * @param {string} opts.actionVerb     e.g. 'assimilating' or 'rejecting' — threaded into the
 *   problem message so each caller's wording stays intact.
 * @returns {string[]} problems — empty when the tree is clean.
 */
function checkCleanTree(projectRoot, { pendingDir, pendingPrefix, actionVerb }) {
  const problems = [];

  // (a) tracked-file modifications
  const tracked = git(projectRoot, ['status', '--porcelain', '--untracked-files=no']);
  if (tracked.status !== 0) {
    problems.push(`clean-tree check failed: git status --untracked-files=no: ${stderrOf(tracked)}`);
    return problems;
  }
  const trackedPaths = (tracked.stdout || '')
    .split('\n')
    .filter(Boolean)
    .map(line => dequote(line.slice(3).trim()));
  if (trackedPaths.length > 0) {
    problems.push(`working tree is dirty — tracked files with uncommitted changes: ${trackedPaths.join(', ')}. Commit or stash them before ${actionVerb} learnings.`);
  }

  // (b) untracked entries other than pendingPrefix/**
  const all = git(projectRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (all.status !== 0) {
    problems.push(`clean-tree check failed: git status --untracked-files=all: ${stderrOf(all)}`);
    return problems;
  }
  const strayUntracked = (all.stdout || '')
    .split('\n')
    .filter(line => line.startsWith('??'))
    .map(line => dequote(line.slice(3).trim()))
    .filter(p => p && !p.startsWith(pendingPrefix));
  if (strayUntracked.length > 0) {
    problems.push(`working tree is dirty — untracked entries outside ${pendingDir}/: ${strayUntracked.join(', ')}. Remove or commit them before ${actionVerb} learnings.`);
  }

  return problems;
}

/**
 * `.sdlc/config.json` (or whatever `configPath` names) must only ever
 * originate from tracked history — an untracked stray copy would be
 * indistinguishable from a clean checkout to every later step.
 *
 * @param {string} projectRoot
 * @param {string} configPath  e.g. '.sdlc/config.json'
 * @returns {boolean}
 */
function hasUntrackedConfig(projectRoot, configPath) {
  if (!fs.existsSync(path.join(projectRoot, ...configPath.split('/')))) return false;
  const tracked = git(projectRoot, ['ls-files', '--error-unmatch', '--', configPath]);
  return tracked.status !== 0;
}

module.exports = { git, stderrOf, dequote, checkCleanTree, hasUntrackedConfig };
