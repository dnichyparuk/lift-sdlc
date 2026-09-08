#!/usr/bin/env node
/**
 * openspec-task-info.js
 * Node port of the former `skills/execute-plan-sdlc/scripts/openspec_wrapper.sh`.
 * Calls `markTaskDone()` (scripts/lib/openspec.js) to flip an OpenSpec
 * tasks.md checkbox.
 *
 * Key Decision 1: the shell version bridged `--change`/`--ref`/`--line`/
 * `--title` into the `node -e` payload via exported env vars
 * (`OPENSPEC_CHANGE`, `OPENSPEC_REF`, `OPENSPEC_LINE`, `OPENSPEC_TITLE` —
 * openspec_wrapper.sh:24-45). This port takes them as ordinary CLI flags
 * instead.
 *
 * Usage:
 *   node openspec-task-info.js --change <name> --ref <ref> [--line <n>] [--title <t>]
 *
 * Output (stdout, single JSON line):
 *   Success: markTaskDone()'s raw return shape —
 *            {"changed":bool,"reason":null|"already-done"|"not-found"|"io-error","line":number|null}
 *   Usage error: {"status":"error","error":"<message>"}
 *
 * An unrecognized flag (or stray positional) is instead reported on stderr as
 * `Unknown parameter passed: <token>` with no stdout JSON, matching the
 * deleted shell wrapper (openspec_wrapper.sh:30).
 *
 * Exit codes:
 *   0 = markTaskDone ran (regardless of `changed`/`reason` — matches the
 *       shell original, which never inspected the result; the caller reads
 *       `changed`/`reason` from the JSON and treats failures as non-blocking
 *       per execute-plan-sdlc/SKILL.md Step 5d-bis)
 *   1 = user-facing validation error (unknown flag, missing --change/--ref)
 *   2 = unexpected script crash
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const path = require('node:path');
const LIB  = path.join(__dirname, '..', 'lib');

const { markTaskDone }  = require(path.join(LIB, 'openspec'));
const { writeJsonLine } = require(path.join(LIB, 'output'));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ change: string|null, ref: string|null, line: string|null, title: string|null, unknown: string|null }}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  let change  = null;
  let ref     = null;
  let line    = null;
  let title   = null;
  let unknown = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--change') change = args[++i];
    else if (a === '--ref') ref = args[++i];
    else if (a === '--line') line = args[++i];
    else if (a === '--title') title = args[++i];
    else { unknown = a; break; }
  }

  return { change: change || null, ref: ref || null, line, title, unknown };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Flip an OpenSpec task's checkbox via `markTaskDone()`.
 *
 * @param {string|null} change
 * @param {string|null} ref
 * @param {string|null} lineArg   Raw `--line` string (converted to Number when truthy, else undefined — mirrors openspec_wrapper.sh's `process.env.OPENSPEC_LINE ? Number(...) : undefined`)
 * @param {string|null} titleArg
 * @param {{ markTaskDoneFn?: Function }} [deps]  Injectable for tests
 * @returns {{ json: object, exitCode: number }}
 */
function runOpenspecTaskInfo(change, ref, lineArg, titleArg, { markTaskDoneFn = markTaskDone } = {}) {
  if (!change || !ref) {
    return { json: { status: 'error', error: '--change and --ref are required' }, exitCode: 1 };
  }

  const line  = lineArg ? Number(lineArg) : undefined;
  const title = titleArg || undefined;

  const result = markTaskDoneFn(change, ref, { line, title });
  return { json: result, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { change, ref, line, title, unknown } = parseArgs(argv);
  if (unknown !== null) {
    process.stderr.write(`Unknown parameter passed: ${unknown}\n`);
    process.exit(1);
  }
  const { json, exitCode } = runOpenspecTaskInfo(change, ref, line, title);
  writeJsonLine(json, { exitCode });
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`openspec-task-info.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, runOpenspecTaskInfo, main };
