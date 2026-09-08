#!/usr/bin/env node
/**
 * await-review.js
 *
 * Node port of skills/ship-sdlc/scripts/await_review.sh.
 *
 * BUG FIX: the shell original only resolved the path to
 * scripts/skill/await-remote-review.js and errored (exit 2) if it could not
 * be found — it never actually ran the resolved script, so the ship-sdlc
 * `await-remote-review` step silently produced no output at all. This file
 * is the actual invocation point: it runs
 * scripts/skill/await-remote-review.js (forwarding every argument it is
 * given unchanged) so that script's single JSON verdict line reaches the
 * caller on stdout, per skills/ship-sdlc/SKILL.md's "After verify-pipeline —
 * await-remote-review" step contract (`node "$AR_SCRIPT" $STEP_ARGS
 * --state-file "$SHIP_STATE_PATH"`, then "Parse the single JSON line on
 * stdout").
 *
 * Usage:
 *   node await-review.js [--pr <n>] [--timeout <s>] [--interval <s>]
 *                        [--reviewers <csv>] [--state-file <path>]
 *   (every argument is forwarded verbatim to
 *   scripts/skill/await-remote-review.js — see that file for the full,
 *   authoritative flag set.)
 *
 * Stdout/stderr: forwarded verbatim from scripts/skill/await-remote-review.js
 * (its single JSON verdict line on stdout, progress logs on stderr).
 *
 * Exit codes:
 *   0 = the target script ran (its own JSON `status` field carries the verdict —
 *       writeJsonLine always exits 0 there, per that file's header)
 *   2 = could not locate scripts/skill/await-remote-review.js, or an unexpected crash
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TARGET_SCRIPT = path.join(__dirname, '..', 'skill', 'await-remote-review.js');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  // Every argument is forwarded unchanged to
  // scripts/skill/await-remote-review.js — see that file's own parseArgs
  // for the accepted flags.
  return { forwardArgs: argv.slice(2) };
}

// ---------------------------------------------------------------------------
// Core (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv  Full argv (process.argv shape).
 * @param {{spawnFn?:Function, targetScript?:string, existsFn?:Function}} [deps]
 * @returns {{exitCode:number, stderr:string|null}}
 */
function runAwaitReview(argv, { spawnFn = spawnSync, targetScript = TARGET_SCRIPT, existsFn = fs.existsSync } = {}) {
  const { forwardArgs } = parseArgs(argv);

  if (!existsFn(targetScript)) {
    return {
      exitCode: 2,
      stderr: 'ERROR: Could not locate scripts/skill/await-remote-review.js. Is the Lift-SDLC plugin installed?\n',
    };
  }

  let result;
  try {
    result = spawnFn(process.execPath, [targetScript, ...forwardArgs], { stdio: 'inherit' });
  } catch (e) {
    return { exitCode: 2, stderr: `ERROR: failed to invoke await-remote-review.js: ${e.message}\n` };
  }

  if (result.error) {
    return { exitCode: 2, stderr: `ERROR: failed to invoke await-remote-review.js: ${result.error.message}\n` };
  }

  return { exitCode: result.status === null ? 2 : result.status, stderr: null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { exitCode, stderr } = runAwaitReview(argv);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

module.exports = { main, parseArgs, runAwaitReview };

if (require.main === module) {
  main(process.argv);
}
