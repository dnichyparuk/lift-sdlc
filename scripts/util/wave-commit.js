#!/usr/bin/env node
/**
 * wave-commit.js — per-wave WIP commit helper (Fixes #392 / R35).
 *
 * Offloads execute-plan-sdlc SKILL.md's Step 5c-quater per-wave WIP commit
 * orchestration — git add/commit and exit-code interpretation — into a
 * deterministic Node helper.
 *
 * Usage:
 *   node wave-commit.js --wave <N> --titles "<title1>|<title2>"
 *
 * Behavior:
 *   1. Composes the WIP commit subject deterministically:
 *        wip(execute): wave {N} — {comma-separated titles}
 *      truncated to 72 chars, appending '…' as the 72nd character when
 *      truncation happens.
 *   2. Runs `git add -A`, then `git commit -m <subject>`. Hooks always
 *      run — never passes --no-verify.
 *   3. Distinguishes three outcomes:
 *      - a real commit landing (returns the new SHA via `git rev-parse HEAD`)
 *      - "nothing to commit" (soft success — no error; mirrors the null-sha
 *        "no diff" normalization already in scripts/state/execute.js
 *        cmdWaveCommitted)
 *      - an actual pre-commit hook failure (hard failure)
 *
 * Output (stdout, one JSON line via writeJsonLine()):
 *   {"committed": true,  "sha": "<sha>", "softSuccess": false}
 *   {"committed": false, "sha": null,    "softSuccess": true}
 *   {"committed": false, "sha": null,    "softSuccess": false, "error": "<message>"}
 *   {"committed": false, "reason": "empty wave title"}
 *     — --titles was passed but every segment was empty/whitespace after
 *       trimming (e.g. `--titles "  "` or `--titles "|  |"`).
 *
 * Exit codes:
 *   0 = committed, or soft success (nothing to commit)
 *   1 = git add/commit failed for a real reason (e.g. pre-commit hook),
 *       empty/whitespace --titles (JSON emitted, see above), or a usage
 *       error (missing/invalid --wave, or --titles omitted entirely — no
 *       JSON emitted for the latter)
 *
 * `sha` feeds directly into the existing state handoff, unchanged:
 *   node scripts/state/execute.js wave-committed --sha <sha>
 *
 * Runs in the current cwd (not resolveSdlcRoot()) so the commit lands in
 * the active worktree when invoked under --workspace worktree (SKILL.md
 * "Workspace-mode compatibility" note).
 *
 * Uses only Node.js built-in modules. No npm install required.
 */
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');
const { writeJsonLine } = require(path.join(LIB, 'output'));

const SUBJECT_MAX = 72;
const ELLIPSIS = '…';
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
 * @returns {{wave: number|null, titles: string[]}}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const waveRaw = getArg(args, '--wave');
  const titlesRaw = getArg(args, '--titles');
  const wave = waveRaw != null && waveRaw !== '' ? Number(waveRaw) : null;
  const titles = titlesRaw
    ? titlesRaw.split('|').map((t) => t.trim()).filter(Boolean)
    : [];
  return { wave, titles };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command and normalize its result. Mirrors
 * verify-tag-ancestry.js / rebase-onto-base.js's spawnSync normalization.
 */
function run(spawnFn, cmdArgs, cwd) {
  const result = spawnFn('git', cmdArgs, { cwd, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

/**
 * Compose the WIP commit subject: `wip(execute): wave {N} — {titles}`,
 * truncated to 72 chars (ellipsis as the 72nd character when truncated).
 *
 * @param {number} wave
 * @param {string[]} titles
 * @returns {string}
 */
function composeSubject(wave, titles) {
  const subject = `wip(execute): wave ${wave} — ${titles.join(', ')}`;
  if (subject.length <= SUBJECT_MAX) return subject;
  return subject.slice(0, SUBJECT_MAX - 1) + ELLIPSIS;
}

// ---------------------------------------------------------------------------
// Core (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * @param {number} wave
 * @param {string[]} titles
 * @param {{spawnFn?: Function, cwd?: string}} [opts]
 * @returns {{committed: boolean, sha: string|null, softSuccess: boolean, error?: string}}
 */
function runWaveCommit(wave, titles, { spawnFn = spawnSync, cwd = process.cwd() } = {}) {
  const subject = composeSubject(wave, titles);

  const addResult = run(spawnFn, ['add', '-A'], cwd);
  if (addResult.status !== 0) {
    return {
      committed: false,
      sha: null,
      softSuccess: false,
      error: `git add -A failed: ${addResult.stderr || addResult.stdout || `exit ${addResult.status}`}`,
    };
  }

  // Hooks always run — never pass --no-verify.
  const commitResult = run(spawnFn, ['commit', '-m', subject], cwd);

  if (commitResult.status !== 0) {
    const combined = `${commitResult.stdout}\n${commitResult.stderr}`;
    if (NOTHING_TO_COMMIT_RE.test(combined)) {
      return { committed: false, sha: null, softSuccess: true };
    }
    return {
      committed: false,
      sha: null,
      softSuccess: false,
      error: commitResult.stderr || commitResult.stdout || `git commit exited ${commitResult.status}`,
    };
  }

  const shaResult = run(spawnFn, ['rev-parse', 'HEAD'], cwd);
  if (shaResult.status !== 0) {
    return {
      committed: false,
      sha: null,
      softSuccess: false,
      error: `commit landed but git rev-parse HEAD failed: ${shaResult.stderr || `exit ${shaResult.status}`}`,
    };
  }

  return { committed: true, sha: shaResult.stdout, softSuccess: false };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { wave, titles } = parseArgs(argv);
  const args = argv.slice(2);
  const titlesFlagPresent = args.indexOf('--titles') !== -1;

  // Missing --wave, or --titles omitted entirely: usage error, no JSON.
  if (wave == null || isNaN(wave) || (!titlesFlagPresent && titles.length === 0)) {
    process.stderr.write('Usage: wave-commit.js --wave <N> --titles "<title1>|<title2>"\n');
    process.exit(1);
  }

  // --titles was passed but every segment was empty/whitespace after
  // trimming (e.g. `--titles "  "` or `--titles "|  |"`): report a
  // structured JSON reason instead of exiting 1 with no output.
  if (titles.length === 0) {
    writeJsonLine({ committed: false, reason: 'empty wave title' }, { exitCode: 1 });
    return;
  }

  const result = runWaveCommit(wave, titles);
  const exitCode = (result.committed || result.softSuccess) ? 0 : 1;
  writeJsonLine(result, { exitCode });
}

module.exports = { parseArgs, composeSubject, runWaveCommit, main };

if (require.main === module) {
  main(process.argv);
}
