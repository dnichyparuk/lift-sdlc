#!/usr/bin/env node
/**
 * parse-verify.js
 * CLI wrapper around `parseVerifySummary()` (scripts/lib/verify-summary.js),
 * mirroring `scripts/util/parse-wave.js`'s structure for the VERIFY_SUMMARY
 * token produced by a received-review verifier subagent.
 *
 * Reuses `readStdin` exported by `scripts/util/parse-wave.js` and
 * `writeJsonLine` from `scripts/lib/output.js` rather than duplicating the
 * stream helper.
 *
 * Usage:
 *   <producer of verifier output> | node parse-verify.js --dispatched-ids '["a","b"]'
 *
 * Output (stdout, single JSON line):
 *   Success: parseVerifySummary()'s raw return shape —
 *            {"schemaOk":bool,"dispatched":[...],"returned":[...],
 *             "missingIds":[...],"extraIds":[...],"parsed":object|null,
 *             "violations":[...],"tokenFound":bool}
 *   Usage error: {"schemaOk":false,"error":"<message>"}
 *
 * Exit codes:
 *   0 = parse ran (schema violations are reported in the JSON, not via exit code)
 *   1 = user-facing validation error (--dispatched-ids present but not valid JSON array)
 *   2 = unexpected script crash
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const path = require('node:path');
const LIB  = path.join(__dirname, '..', 'lib');

const { parseVerifySummary } = require(path.join(LIB, 'verify-summary'));
const { writeJsonLine }      = require(path.join(LIB, 'output'));
const { readStdin }          = require('./parse-wave');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ dispatchedIdsRaw: string|null }}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  let dispatchedIdsRaw = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dispatched-ids') {
      dispatchedIdsRaw = args[++i];
    }
  }

  return { dispatchedIdsRaw };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Parse `--dispatched-ids` JSON (if given) and run `parseVerifySummary()`
 * against the verifier subagent text read from stdin.
 *
 * @param {string} text                    Verifier subagent response text (from stdin)
 * @param {string|null} dispatchedIdsRaw   Raw `--dispatched-ids` flag value, or null when absent
 * @param {{ parseVerifySummaryFn?: Function }} [deps]  Injectable for tests
 * @returns {{ json: object, exitCode: number }}
 */
function runParseVerify(text, dispatchedIdsRaw, { parseVerifySummaryFn = parseVerifySummary } = {}) {
  let dispatched = [];

  if (dispatchedIdsRaw !== null && dispatchedIdsRaw !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(dispatchedIdsRaw);
    } catch (err) {
      return { json: { schemaOk: false, error: `--dispatched-ids is not valid JSON: ${err.message}` }, exitCode: 1 };
    }
    if (!Array.isArray(parsed)) {
      return { json: { schemaOk: false, error: '--dispatched-ids must be a JSON array' }, exitCode: 1 };
    }
    dispatched = parsed;
  }

  const result = parseVerifySummaryFn(text, dispatched);
  return { json: result, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
  const { dispatchedIdsRaw } = parseArgs(argv);
  const text = await readStdin();
  const { json, exitCode } = runParseVerify(text, dispatchedIdsRaw);
  writeJsonLine(json, { exitCode });
}

if (require.main === module) {
  main(process.argv).catch((err) => {
    process.stderr.write(`parse-verify.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  });
}

module.exports = { parseArgs, runParseVerify, main };
