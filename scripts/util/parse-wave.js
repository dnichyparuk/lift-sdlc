#!/usr/bin/env node
/**
 * parse-wave.js
 * Node port of the former `skills/execute-plan-sdlc/scripts/parse_wave.sh`.
 * Parses a wave-runner Agent's `WAVE_SUMMARY` token via `parseWaveSummary()`
 * (scripts/lib/wave-summary.js).
 *
 * Cross-platform fixes over the shell version:
 *   - Reads the wave-runner output from `process.stdin` instead of the
 *     POSIX-only `/dev/stdin` heredoc (parse_wave.sh:9-15).
 *   - Takes the dispatched task IDs as an explicit `--dispatched-ids
 *     <json-array>` CLI flag instead of the ambient `DISPATCHED_IDS`
 *     environment variable.
 *
 * Usage:
 *   <producer of wave-runner text> | node parse-wave.js --dispatched-ids '["1","2"]'
 *
 * Output (stdout, single JSON line):
 *   Success: parseWaveSummary()'s raw return shape —
 *            {"schemaOk":bool,"dispatched":[...],"returned":[...],
 *             "missingIds":[...],"extraIds":[...],"parsed":object|null,
 *             "violations":[...],"tokenFound":bool}
 *   Usage error: {"schemaOk":false,"error":"<message>"}
 *
 * Exit codes:
 *   0 = parse ran (schema violations are reported in the JSON, not via exit code —
 *       matches the shell original, which always exited 0 on a successful parse)
 *   1 = user-facing validation error (--dispatched-ids present but not valid JSON array)
 *   2 = unexpected script crash
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const path = require('node:path');
const LIB  = path.join(__dirname, '..', 'lib');

const { parseWaveSummary } = require(path.join(LIB, 'wave-summary'));
const { writeJsonLine }    = require(path.join(LIB, 'output'));

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
// stdin helper
// ---------------------------------------------------------------------------

/**
 * Read all of stdin as a UTF-8 string.
 * @returns {Promise<string>}
 */
function readStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');

    const onData = (chunk) => { data += chunk; };
    const onEnd = () => settle(() => resolve(data));
    const onError = (err) => settle(() => reject(err));

    function settle(action) {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      action();
    }

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.resume();
  });
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Parse `--dispatched-ids` JSON (if given) and run `parseWaveSummary()`
 * against the wave-runner text read from stdin.
 *
 * @param {string} text                    Wave-runner Agent response text (from stdin)
 * @param {string|null} dispatchedIdsRaw   Raw `--dispatched-ids` flag value, or null when absent
 * @param {{ parseWaveSummaryFn?: Function }} [deps]  Injectable for tests
 * @returns {{ json: object, exitCode: number }}
 */
function runParseWave(text, dispatchedIdsRaw, { parseWaveSummaryFn = parseWaveSummary } = {}) {
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

  const result = parseWaveSummaryFn(text, dispatched);
  return { json: result, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
  const { dispatchedIdsRaw } = parseArgs(argv);
  const text = await readStdin();
  const { json, exitCode } = runParseWave(text, dispatchedIdsRaw);
  writeJsonLine(json, { exitCode });
}

if (require.main === module) {
  main(process.argv).catch((err) => {
    process.stderr.write(`parse-wave.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  });
}

module.exports = { parseArgs, runParseWave, readStdin, main };
