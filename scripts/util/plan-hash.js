#!/usr/bin/env node
/**
 * plan-hash.js (CLI)
 * Thin wrapper around `computePlanHash()` (scripts/lib/plan-hash.js).
 *
 * Node port of the former `skills/execute-plan-sdlc/scripts/plan_hash.sh`,
 * which validated its argument in bash and then shelled out to an inline
 * `node -e` block to do the hashing.
 *
 * Usage:
 *   node plan-hash.js <file-path>
 *
 * Output (stdout): the lowercase SHA-256 hex digest followed by a newline.
 * Nothing else is written to stdout — the caller compares the digest verbatim.
 *
 * Exit codes:
 *   0 = success (digest on stdout)
 *   1 = user-facing validation error (missing argument, file not found)
 *   2 = unexpected crash (unreadable file, etc.)
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { computePlanHash } = require(path.join(__dirname, '..', 'lib', 'plan-hash'));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv  Full argv (process.argv shape).
 * @returns {{filePath: string|null, scriptName: string}}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    filePath: args[0] || null,
    scriptName: argv[1] || 'plan-hash.js',
  };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Validate the argument and hash the file. Mirrors `plan_hash.sh:4-25`:
 * an empty argument prints the `Usage:` line, a non-file path prints the
 * `Error: File '<path>' not found` line (both exit 1), and a read failure
 * prints `Error hashing file: <msg>` (exit 2).
 *
 * @param {string[]} argv  Full argv (process.argv shape).
 * @param {{computePlanHashFn?: Function}} [deps]  Injectable for tests.
 * @returns {{stdout: string, stderr: string, exitCode: number}}
 */
function runPlanHash(argv, { computePlanHashFn = computePlanHash } = {}) {
  const { filePath, scriptName } = parseArgs(argv);

  if (!filePath) {
    return { stdout: '', stderr: `Usage: ${scriptName} <file-path>\n`, exitCode: 1 };
  }

  let isFile = false;
  try {
    isFile = fs.statSync(filePath).isFile();
  } catch (_) {
    isFile = false;
  }
  if (!isFile) {
    return { stdout: '', stderr: `Error: File '${filePath}' not found\n`, exitCode: 1 };
  }

  let hash;
  try {
    hash = computePlanHashFn(filePath);
  } catch (err) {
    return { stdout: '', stderr: `Error hashing file: ${err.message}\n`, exitCode: 2 };
  }

  return { stdout: `${hash}\n`, stderr: '', exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { stdout, stderr, exitCode } = runPlanHash(argv);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`Error hashing file: ${err.message}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, runPlanHash, main };
