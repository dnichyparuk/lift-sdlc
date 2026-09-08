#!/usr/bin/env node
/**
 * extract-plan-file.js
 * Reads a prepare-script JSON manifest file and extracts `context.planFile`
 * from it, reporting `{ planFile }` through the writeOutput() manifest-file
 * protocol (issue #209 — never print raw JSON to stdout).
 *
 * Replaces `skills/ship-sdlc/scripts/resolve_plan_file.sh`, which bridged
 * its input via an ambient `F` env var (`F="$1" node -e "...process.env.F..."`).
 * This script takes the JSON file path as a positional argv arg instead,
 * removing the env-var indirection.
 *
 * Usage:
 *   node extract-plan-file.js <json-file-path>
 *
 * Exit codes:
 *   0 = success
 *   1 = user-facing validation error (missing arg, unreadable/invalid file)
 *   2 = unexpected script crash
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const { writeOutput } = require(path.join(__dirname, '..', 'lib', 'output'));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  return { jsonFilePath: args[0] || null };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Read a JSON manifest file and extract `context.planFile` from it.
 *
 * @param {string|null} jsonFilePath  Absolute (or cwd-relative) path to the JSON file
 * @returns {{ ok: boolean, planFile: string, errors: string[] }}
 */
function extractPlanFile(jsonFilePath) {
  if (!jsonFilePath) {
    return { ok: false, planFile: '', errors: ['A JSON file path argument is required.'] };
  }

  let raw;
  try {
    raw = fs.readFileSync(jsonFilePath, 'utf8');
  } catch (err) {
    return { ok: false, planFile: '', errors: [`Could not read JSON file at ${jsonFilePath}: ${err.message}`] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, planFile: '', errors: [`Could not parse JSON in file at ${jsonFilePath}: ${err.message}`] };
  }

  const planFile = (parsed && parsed.context && parsed.context.planFile) || '';
  return { ok: true, planFile, errors: [] };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { jsonFilePath } = parseArgs(argv);
  const result = extractPlanFile(jsonFilePath);
  writeOutput(result, 'extract-plan-file', result.ok ? 0 : 1);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`extract-plan-file.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, extractPlanFile, main };
