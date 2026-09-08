#!/usr/bin/env node
/**
 * openspec-tasks.js
 * Node port of the former `skills/execute-plan-sdlc/scripts/openspec_tasks_wrapper.sh`.
 * Reads `openspec/changes/<change>/tasks.md` and parses it via
 * `parseTasks()` (scripts/lib/openspec.js).
 *
 * Fixes the shell version's string-interpolated path
 * (`"openspec/changes/$NAME/tasks.md"`) by resolving the tasks-file path
 * with `path.join()` instead.
 *
 * Usage:
 *   node openspec-tasks.js --change <name>
 *   node openspec-tasks.js --name <name>     (alias, matches
 *                                              openspec_tasks_wrapper.sh:21-45)
 *
 * Output (stdout, single JSON line):
 *   Success: {"status":"success","tasks":[{ref,line,title,indent,done}, ...]}
 *   Error:   {"status":"error","error":"<message>"}
 * An unrecognized flag (or stray positional) is instead reported on stderr as
 * `Unknown parameter passed: <token>` with no stdout JSON, matching the
 * deleted shell wrapper (openspec_tasks_wrapper.sh:24).
 *
 * Exit codes:
 *   0 = success
 *   1 = user-facing validation error (unknown flag, missing --change/--name, tasks.md not found)
 *   2 = unexpected script crash
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const LIB  = path.join(__dirname, '..', 'lib');

const { parseTasks }    = require(path.join(LIB, 'openspec'));
const { writeJsonLine } = require(path.join(LIB, 'output'));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ change: string|null, unknown: string|null }}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  let change  = null;
  let unknown = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--change' || a === '--name') {
      change = args[++i];
    } else {
      unknown = a;
      break;
    }
  }

  return { change: change || null, unknown };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Resolve and parse the tasks.md file for an OpenSpec change.
 *
 * @param {string} cwd            Project root to resolve `openspec/changes/<change>/tasks.md` against
 * @param {string|null} change    Name of the change directory
 * @param {{ parseTasksFn?: Function, readFileSyncFn?: Function, existsSyncFn?: Function }} [deps]  Injectable for tests
 * @returns {{ json: object, exitCode: number }}
 */
function runOpenspecTasks(cwd, change, {
  parseTasksFn   = parseTasks,
  readFileSyncFn = fs.readFileSync,
  existsSyncFn   = fs.existsSync,
} = {}) {
  if (!change) {
    return { json: { status: 'error', error: '--change (or --name) is required' }, exitCode: 1 };
  }

  const tasksPath = path.join(cwd, 'openspec', 'changes', change, 'tasks.md');

  if (!existsSyncFn(tasksPath)) {
    return { json: { status: 'error', error: `file does not exist: ${tasksPath}` }, exitCode: 1 };
  }

  const content = readFileSyncFn(tasksPath, 'utf8');
  return { json: { status: 'success', tasks: parseTasksFn(content) }, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { change, unknown } = parseArgs(argv);
  if (unknown !== null) {
    process.stderr.write(`Unknown parameter passed: ${unknown}\n`);
    process.exit(1);
  }
  const { json, exitCode } = runOpenspecTasks(process.cwd(), change);
  writeJsonLine(json, { exitCode });
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`openspec-tasks.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, runOpenspecTasks, main };
