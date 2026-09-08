#!/usr/bin/env node
/**
 * verify-completeness.js
 *
 * Node port of skills/ship-sdlc/scripts/verify_completeness.sh — runs the
 * execute-plan-sdlc post-execution completeness invariant
 * (`node scripts/state/execute.js verify-completeness`,
 * R-INVARIANT-COMPLETENESS, #432) and, when it reports unaccounted tasks,
 * marks the ship pipeline's `execute` step failed so the caller halts
 * rather than advancing to commit/review/version/pr.
 *
 * The shell original wrapped the subprocess call in a `set +e` / `set -e` /
 * `$?`-capture dance and shelled out to a sibling `todos_wrapper.sh` to
 * render the failure TodoWrite payload. This port replaces the set+e dance
 * with a plain try/catch and calls the ship-todos rendering logic directly
 * via require('../lib/ship-todos') instead of spawning a wrapper script
 * (todos_wrapper.sh no longer exists as a standalone file).
 *
 * Usage:
 *   node verify-completeness.js --state-file <path> --plan-file <path>
 *
 * Exit codes:
 *   0  = all planned tasks accounted for
 *   1  = --state-file / --plan-file missing, or an unknown flag was passed
 *   2  = could not locate scripts/state/execute.js, or an unexpected crash
 *   65 = one or more planned tasks unaccounted for (passed through from
 *        `scripts/state/execute.js verify-completeness`; BSD EX_DATAERR)
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { renderTodos, parsePlanTasks } = require(path.join(__dirname, '..', 'lib', 'ship-todos'));

const EXECUTE_STATE_SCRIPT = path.join(__dirname, '..', 'state', 'execute.js');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let stateFile = null;
  let planFile  = null;
  const errors = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--state-file' && args[i + 1] !== undefined) {
      stateFile = args[++i];
    } else if (a === '--plan-file' && args[i + 1] !== undefined) {
      planFile = args[++i];
    } else {
      errors.push(`Unknown parameter passed: ${a}`);
    }
  }

  return { stateFile, planFile, errors };
}

// ---------------------------------------------------------------------------
// Failure-path TodoWrite rendering (replaces todos_wrapper.sh)
// ---------------------------------------------------------------------------

/**
 * Render the "execute step failed" TodoWrite payload directly via
 * lib/ship-todos, mirroring what `todos_wrapper.sh --event execute
 * --fail-step execute` used to shell out for.
 *
 * @param {string} stateFile
 * @param {string} planFile
 * @param {{readFileFn?:Function}} [deps]
 * @returns {{marker:string, json:string}|null} null when the state file
 *   could not be read (failure surfaced as a stderr warning, non-fatal —
 *   matches the shell original, which did not itself validate the
 *   sibling wrapper's inputs before calling it).
 */
function markExecuteFailed(stateFile, planFile, { readFileFn = fs.readFileSync } = {}) {
  let state;
  try {
    state = JSON.parse(readFileFn(stateFile, 'utf8'));
  } catch (e) {
    process.stderr.write(`Warning: could not read state file for TodoWrite update: ${e.message}\n`);
    return null;
  }

  let planTasks = [];
  try {
    const md = readFileFn(planFile, 'utf8');
    planTasks = parsePlanTasks(md);
  } catch (e) {
    process.stderr.write(`Warning: could not read plan file for TodoWrite update: ${e.message}\n`);
  }

  const result = renderTodos(state, { event: 'execute', failStep: 'execute', planTasks });
  process.stderr.write(result.marker + '\n');
  const json = JSON.stringify(result, null, 2) + '\n';
  process.stdout.write(json);
  return { marker: result.marker, json };
}

// ---------------------------------------------------------------------------
// Core (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv  Full argv (process.argv shape).
 * @param {{spawnFn?:Function, executeScript?:string, existsFn?:Function}} [deps]
 * @returns {{exitCode:number, stderr:string|null}}
 */
function runVerifyCompleteness(argv, { spawnFn = spawnSync, executeScript = EXECUTE_STATE_SCRIPT, existsFn = fs.existsSync } = {}) {
  const args = parseArgs(argv);

  if (args.errors.length > 0) {
    return { exitCode: 1, stderr: args.errors.join('\n') + '\n' };
  }

  if (!args.stateFile || !args.planFile) {
    return { exitCode: 1, stderr: 'ERROR: --state-file and --plan-file are required\n' };
  }

  if (!existsFn(executeScript)) {
    return { exitCode: 2, stderr: `ERROR: Could not locate ${executeScript}\n` };
  }

  let completenessExit;
  try {
    const result = spawnFn(process.execPath, [executeScript, 'verify-completeness'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    completenessExit = result.status === null ? 2 : result.status;
  } catch (e) {
    return { exitCode: 2, stderr: `Unexpected error running verify-completeness: ${e.message}\n` };
  }

  if (completenessExit !== 0) {
    process.stderr.write(
      'ERROR: execute-plan-sdlc returned but planned tasks are unaccounted. Pipeline halted.\n'
    );
    markExecuteFailed(args.stateFile, args.planFile);
    return { exitCode: completenessExit, stderr: null };
  }

  return { exitCode: 0, stderr: null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { exitCode, stderr } = runVerifyCompleteness(argv);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

module.exports = { main, parseArgs, runVerifyCompleteness, markExecuteFailed };

if (require.main === module) {
  main(process.argv);
}
