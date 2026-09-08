#!/usr/bin/env node
/**
 * openspec-validate.js
 * Thin CLI wrapper around `validateChangeStrict()` (scripts/lib/openspec.js)
 * that runs `openspec validate <change> --strict` and reports the result
 * through the writeOutput() manifest-file protocol (issue #209 — never
 * print raw JSON to stdout).
 *
 * Usage:
 *   node openspec-validate.js <change-name>
 *
 * Exit codes:
 *   0 = validation passed
 *   1 = user-facing validation error (missing arg, validation reported failure)
 *   2 = unexpected script crash
 *
 * Shared: this is the single canonical copy consumed by BOTH ship-sdlc and
 * execute-plan-sdlc (see fact sheet Task 3 / Task 6 sync note) — do not
 * create a second copy, and keep this file skill-agnostic.
 */

'use strict';

const path = require('node:path');

const { validateChangeStrict } = require(path.join(__dirname, '..', 'lib', 'openspec'));
const { writeOutput } = require(path.join(__dirname, '..', 'lib', 'output'));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  return { changeName: args[0] || null };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Validate an OpenSpec change (strict mode) and normalize the result for
 * writeOutput().
 *
 * @param {string} cwd         Working directory to run `openspec validate` from
 * @param {string|null} changeName  Name of the change directory
 * @param {{ validateChangeStrictFn?: Function }} [deps]  Injectable for tests
 * @returns {{ ok: boolean, stdout: string, stderr: string, cliAvailable: boolean, errors: string[] }}
 */
function runOpenspecValidate(cwd, changeName, { validateChangeStrictFn = validateChangeStrict } = {}) {
  if (!changeName) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      cliAvailable: null,
      errors: ['A change-name argument is required.'],
    };
  }

  const result = validateChangeStrictFn(cwd, changeName);
  return {
    ...result,
    errors: result.ok ? [] : [result.stderr || 'openspec validate --strict failed'],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { changeName } = parseArgs(argv);
  const result = runOpenspecValidate(process.cwd(), changeName);
  writeOutput(result, 'openspec-validate', result.ok ? 0 : 1);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`openspec-validate.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, runOpenspecValidate, main };
