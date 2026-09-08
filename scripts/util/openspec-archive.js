#!/usr/bin/env node
/**
 * openspec-archive.js
 * Thin CLI wrapper around `runArchive()` (scripts/lib/openspec.js) that
 * archives an OpenSpec change via the `openspec` CLI and reports the
 * result through the writeOutput() manifest-file protocol (issue #209 —
 * never print raw JSON to stdout).
 *
 * Usage:
 *   node openspec-archive.js <change-name>
 *
 * Exit codes:
 *   0 = archive succeeded (or, per underlying CLI semantics, ran without error)
 *   1 = user-facing validation error (missing arg, archive reported failure)
 *   2 = unexpected script crash
 *
 * Shared: also consumed as-is by execute-plan-sdlc's openspec_validate.sh
 * migration (see scripts/util/openspec-validate.js) — this file stays
 * ship-sdlc/skill-agnostic (no skill-specific branding or paths).
 */

'use strict';

const path = require('node:path');

const { runArchive } = require(path.join(__dirname, '..', 'lib', 'openspec'));
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
 * Archive an OpenSpec change and normalize the result for writeOutput().
 *
 * @param {string} cwd         Working directory to run `openspec archive` from
 * @param {string|null} changeName  Name of the change directory
 * @param {{ runArchiveFn?: Function }} [deps]  Injectable for tests
 * @returns {{ ok: boolean, stdout: string, stderr: string, cliAvailable: boolean, errors: string[] }}
 */
function runOpenspecArchive(cwd, changeName, { runArchiveFn = runArchive } = {}) {
  if (!changeName) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      cliAvailable: null,
      errors: ['A change-name argument is required.'],
    };
  }

  const result = runArchiveFn(cwd, changeName);
  return {
    ...result,
    errors: result.ok ? [] : [result.stderr || 'openspec archive failed'],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { changeName } = parseArgs(argv);
  const result = runOpenspecArchive(process.cwd(), changeName);
  writeOutput(result, 'openspec-archive', result.ok ? 0 : 1);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`openspec-archive.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, runOpenspecArchive, main };
