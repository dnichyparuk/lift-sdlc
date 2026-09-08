#!/usr/bin/env node
/**
 * ship-git-ops.js — ship-sdlc git-ops helpers.
 *
 * Offloads three inline shell sequences from ship-sdlc/SKILL.md into
 * deterministic, testable subcommands so the SKILL.md stops constructing
 * git commands inline and instead reads each subcommand's JSON:
 *
 *   - "Between execute and commit" (staging gap after execute-plan-sdlc)
 *   - "After pr — learnings-commit" (trailing chore commit for pipeline learnings)
 *   - "Between version and pr — archive-openspec" (openspec/ archive commit)
 *
 * Usage:
 *   node ship-git-ops.js stage-post-execute
 *   node ship-git-ops.js commit-learnings
 *   node ship-git-ops.js commit-openspec-archive --change <name>
 *
 * Output: one JSON line via writeJsonLine() (lib/output.js).
 *
 * `spawnFn` is injectable on every exported core function so tests can run
 * without a real git repo. Runs in the current cwd (not resolveSdlcRoot()),
 * matching the other new util scripts, so the git ops land in the active
 * worktree when invoked under --workspace worktree.
 *
 * Uses only Node.js built-in modules. No npm install required.
 */
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');
const { writeJsonLine } = require(path.join(LIB, 'output'));
const { isArchived } = require(path.join(LIB, 'openspec'));

const NOTHING_TO_COMMIT_RE = /nothing to commit/i;

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
 * @returns {{command: string|null, change: string|null}}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    command: args[0] || null,
    change: getArg(args, '--change'),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command and normalize its result. Mirrors
 * wave-commit.js / rollback-stash.js's spawnSync result normalization.
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
 * Stage everything except `.sdlc/` after execute-plan-sdlc, which creates
 * and modifies files but does not stage them.
 * Mirrors SKILL.md "Between execute and commit": `git add -A -- ':!.sdlc/'`.
 *
 * @param {{spawnFn?: Function, cwd?: string}} [opts]
 * @returns {{staged: string[]} | {staged: [], error: string}}
 */
function stagePostExecute({ spawnFn = spawnSync, cwd = process.cwd() } = {}) {
  const addResult = run(spawnFn, ['add', '-A', '--', ':!.sdlc/'], cwd);
  if (addResult.status !== 0) {
    return {
      staged: [],
      error: `git add -A -- ':!.sdlc/' failed: ${addResult.stderr || addResult.stdout || `exit ${addResult.status}`}`,
    };
  }

  const diffResult = run(spawnFn, ['diff', '--cached', '--name-only'], cwd);
  const staged = diffResult.stdout ? diffResult.stdout.split('\n').filter(Boolean) : [];
  return { staged };
}

/**
 * Capture pipeline-level learnings in a trailing chore commit so
 * post-pipeline `git status` is clean (issue #208).
 * Mirrors SKILL.md "After pr — learnings-commit":
 *   git diff --quiet -- .sdlc/learnings/log.md   (skip if clean)
 *   git add .sdlc/learnings/log.md
 *   git commit -m "chore(ship-sdlc): capture pipeline learnings"
 *   git push   (non-fatal on failure)
 *   git status --porcelain   (post-condition assert — MUST be empty)
 *
 * @param {{spawnFn?: Function, cwd?: string, learningsPath?: string, message?: string}} [opts]
 * @returns {{committed: false, reason: string} | {committed: true, pushed: boolean, reason?: string, dirty?: boolean, postConditionReason?: string}}
 */
function commitLearnings({
  spawnFn = spawnSync,
  cwd = process.cwd(),
  learningsPath = '.sdlc/learnings/log.md',
  message = 'chore(ship-sdlc): capture pipeline learnings',
} = {}) {
  const diffResult = run(spawnFn, ['diff', '--quiet', '--', learningsPath], cwd);
  if (diffResult.status === 0) {
    return { committed: false, reason: 'clean' };
  }

  const addResult = run(spawnFn, ['add', learningsPath], cwd);
  if (addResult.status !== 0) {
    return {
      committed: false,
      reason: `git add failed: ${addResult.stderr || addResult.stdout || `exit ${addResult.status}`}`,
    };
  }

  const commitResult = run(spawnFn, ['commit', '-m', message], cwd);
  if (commitResult.status !== 0) {
    return {
      committed: false,
      reason: `git commit failed: ${commitResult.stderr || commitResult.stdout || `exit ${commitResult.status}`}`,
    };
  }

  // Push failure is non-fatal — the local commit still lands and a
  // follow-up `git push` will deliver it.
  const pushResult = run(spawnFn, ['push'], cwd);
  const pushed = pushResult.status === 0;

  const result = { committed: true, pushed };
  if (!pushed) {
    result.reason = pushResult.stderr || pushResult.stdout || `git push exited ${pushResult.status}`;
  }

  // Post-condition assert: git status --porcelain MUST be empty.
  const statusResult = run(spawnFn, ['status', '--porcelain'], cwd);
  if (statusResult.status !== 0 || statusResult.stdout !== '') {
    result.dirty = true;
    result.postConditionReason = statusResult.status !== 0
      ? (statusResult.stderr || `git status --porcelain exited ${statusResult.status}`)
      : `working tree not clean after learnings commit: ${statusResult.stdout}`;
  }

  return result;
}

/**
 * Commit the openspec/ archive, gated by isArchived() so a commit never
 * lands for a change that was not actually archived.
 * Mirrors SKILL.md "Between version and pr — archive-openspec" steps 6-7:
 *   git add openspec/
 *   git commit -m "chore(openspec): archive <name>"
 *
 * @param {string} changeName
 * @param {{spawnFn?: Function, cwd?: string, isArchivedFn?: Function}} [opts]
 * @returns {{committed: boolean, reason?: string}}
 */
function commitOpenspecArchive(changeName, { spawnFn = spawnSync, cwd = process.cwd(), isArchivedFn = isArchived } = {}) {
  if (!isArchivedFn(cwd, changeName)) {
    return { committed: false, reason: 'not-archived' };
  }

  const addResult = run(spawnFn, ['add', 'openspec/'], cwd);
  if (addResult.status !== 0) {
    return {
      committed: false,
      reason: `git add failed: ${addResult.stderr || addResult.stdout || `exit ${addResult.status}`}`,
    };
  }

  const commitResult = run(spawnFn, ['commit', '-m', `chore(openspec): archive ${changeName}`], cwd);
  if (commitResult.status !== 0) {
    const combined = `${commitResult.stdout}\n${commitResult.stderr}`;
    if (NOTHING_TO_COMMIT_RE.test(combined)) {
      return { committed: false, reason: 'clean' };
    }
    return {
      committed: false,
      reason: commitResult.stderr || commitResult.stdout || `git commit exited ${commitResult.status}`,
    };
  }

  return { committed: true };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function usage() {
  return (
    'Usage:\n' +
    '  ship-git-ops.js stage-post-execute\n' +
    '  ship-git-ops.js commit-learnings\n' +
    '  ship-git-ops.js commit-openspec-archive --change <name>\n'
  );
}

function main(argv) {
  const { command, change } = parseArgs(argv);

  let result;
  let exitCode;

  if (command === 'stage-post-execute') {
    result = stagePostExecute();
    exitCode = result.error ? 1 : 0;
  } else if (command === 'commit-learnings') {
    result = commitLearnings();
    // Push failure is never fatal (result.pushed === false while
    // result.committed === true still exits 0). A real add/commit failure,
    // or a failed post-condition assert, is a genuine problem.
    exitCode = (result.committed === false && result.reason !== 'clean') || result.dirty ? 1 : 0;
  } else if (command === 'commit-openspec-archive') {
    if (!change) {
      process.stderr.write(usage());
      process.exit(1);
      return;
    }
    result = commitOpenspecArchive(change);
    exitCode = (result.committed === false && result.reason !== 'clean' && result.reason !== 'not-archived') ? 1 : 0;
  } else {
    process.stderr.write(usage());
    process.exit(1);
    return;
  }

  writeJsonLine(result, { exitCode });
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { parseArgs, stagePostExecute, commitLearnings, commitOpenspecArchive, main };
