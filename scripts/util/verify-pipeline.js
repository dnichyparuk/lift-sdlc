#!/usr/bin/env node
/**
 * verify-pipeline.js
 *
 * Node port of skills/ship-sdlc/scripts/verify_pipeline.sh.
 *
 * BUG FIX: the shell original only resolved the path to
 * scripts/skill/verify-pipeline.js and errored (exit 2) if it could not be
 * found — it never actually ran the resolved script, so the ship-sdlc
 * `verify-pipeline` step silently produced no output at all. This file is
 * the actual invocation point: it runs scripts/skill/verify-pipeline.js
 * (forwarding every argument it is given unchanged) so that script's single
 * JSON verdict line reaches the caller on stdout, per
 * skills/ship-sdlc/SKILL.md's "After pr — verify-pipeline" step contract
 * (`node "$VP_SCRIPT" $STEP_ARGS --state-file "$SHIP_STATE_PATH"`, then
 * "Parse the single JSON line on stdout").
 *
 * Usage:
 *   node verify-pipeline.js [--pr <n>] [--timeout <s>] [--interval <s>] [--state-file <path>]
 *   (every argument is forwarded verbatim to scripts/skill/verify-pipeline.js
 *   — see that file for the full, authoritative flag set.)
 *
 * Stdout/stderr: forwarded verbatim from scripts/skill/verify-pipeline.js
 * (its single JSON verdict line on stdout, progress logs on stderr).
 *
 * Exit codes:
 *   0 = the target script ran (its own JSON `status` field carries the verdict —
 *       writeJsonLine always exits 0 there, per that file's header)
 *   2 = could not locate scripts/skill/verify-pipeline.js, or an unexpected crash
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TARGET_SCRIPT = path.join(__dirname, '..', 'skill', 'verify-pipeline.js');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  // Every argument is forwarded unchanged to
  // scripts/skill/verify-pipeline.js — see that file's own parseArgs for the
  // accepted flags.
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
function runVerifyPipeline(argv, { spawnFn = spawnSync, targetScript = TARGET_SCRIPT, existsFn = fs.existsSync } = {}) {
  const { forwardArgs } = parseArgs(argv);

  if (!existsFn(targetScript)) {
    return {
      exitCode: 2,
      stderr: 'ERROR: Could not locate scripts/skill/verify-pipeline.js. Is the Lift-SDLC plugin installed?\n',
    };
  }

  let result;
  try {
    result = spawnFn(process.execPath, [targetScript, ...forwardArgs], { stdio: 'inherit' });
  } catch (e) {
    return { exitCode: 2, stderr: `ERROR: failed to invoke verify-pipeline.js: ${e.message}\n` };
  }

  if (result.error) {
    return { exitCode: 2, stderr: `ERROR: failed to invoke verify-pipeline.js: ${result.error.message}\n` };
  }

  return { exitCode: result.status === null ? 2 : result.status, stderr: null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { exitCode, stderr } = runVerifyPipeline(argv);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

module.exports = { main, parseArgs, runVerifyPipeline };

if (require.main === module) {
  main(process.argv);
}
