#!/usr/bin/env node
/**
 * plan-mode-check.js
 *
 * Node port of skills/ship-sdlc/scripts/plan_mode_check.sh — runs
 * scripts/skill/ship.js with `--output-file --plan-mode-blocked` plus every
 * argument this script receives, then prints the captured output-file path
 * and exit code in the same four-line shape the shell original produced.
 *
 * Preserves $ARGUMENTS template-substitution compatibility from
 * plan_mode_check.sh:10 (`node "$SCRIPT" --output-file --plan-mode-blocked
 * $ARGUMENTS`): SKILL.md's invocation of this file appends the caller's
 * literal $ARGUMENTS after the two fixed flags, and every one of those
 * words is forwarded to ship.js unchanged — no flag validation is applied
 * here, matching the shell original's blind pass-through.
 *
 * Usage:
 *   node plan-mode-check.js [<forwarded args...>]
 *
 * Output (stdout):
 *   PLAN_MODE_OUTPUT_FILE=<path>
 *   PLAN_MODE_EXIT=<code>
 *   PLAN_MODE_OUTPUT_FILE: <path>
 *   STATUS: <code>
 *
 * Note: like the shell original (which had no trailing `exit` statement),
 * this process exits 0 whenever ship.js was actually invoked — the caller
 * reads pass/fail from the printed STATUS line, not from this script's own
 * exit code. Exit 2 is reserved for the one case the shell original did
 * exit non-zero for: scripts/skill/ship.js could not be located.
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SHIP_SCRIPT = path.join(__dirname, '..', 'skill', 'ship.js');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  // Forwarded verbatim to ship.js after --output-file --plan-mode-blocked.
  return { forwardArgs: argv.slice(2) };
}

// ---------------------------------------------------------------------------
// Core (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv  Full argv (process.argv shape).
 * @param {{spawnFn?:Function, shipScript?:string, existsFn?:Function}} [deps]
 * @returns {{lines:string[], stderr:string|null, exitCode:number}}
 */
function runPlanModeCheck(argv, { spawnFn = spawnSync, shipScript = SHIP_SCRIPT, existsFn = fs.existsSync } = {}) {
  const { forwardArgs } = parseArgs(argv);

  if (!existsFn(shipScript)) {
    return {
      lines: [],
      stderr: 'ERROR: Could not locate scripts/skill/ship.js. Is the Lift-SDLC plugin installed?\n',
      exitCode: 2,
    };
  }

  let result;
  try {
    result = spawnFn(
      process.execPath,
      [shipScript, '--output-file', '--plan-mode-blocked', ...forwardArgs],
      // Only stdout is captured — mirrors the shell original's $(...) command
      // substitution, which captures stdout only; stdin/stderr stay live.
      { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' }
    );
  } catch (e) {
    return { lines: [], stderr: `ERROR: failed to invoke ship.js: ${e.message}\n`, exitCode: 2 };
  }

  if (result.error) {
    return { lines: [], stderr: `ERROR: failed to invoke ship.js: ${result.error.message}\n`, exitCode: 2 };
  }

  const outputFile = (result.stdout || '').trim();
  const exitCode = result.status === null ? 2 : result.status;

  return {
    lines: [
      `PLAN_MODE_OUTPUT_FILE=${outputFile}`,
      `PLAN_MODE_EXIT=${exitCode}`,
      `PLAN_MODE_OUTPUT_FILE: ${outputFile}`,
      `STATUS: ${exitCode}`,
    ],
    stderr: null,
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { lines, stderr, exitCode } = runPlanModeCheck(argv);
  if (stderr) process.stderr.write(stderr);
  for (const line of lines) process.stdout.write(line + '\n');
  process.exit(exitCode);
}

module.exports = { main, parseArgs, runPlanModeCheck };

if (require.main === module) {
  main(process.argv);
}
