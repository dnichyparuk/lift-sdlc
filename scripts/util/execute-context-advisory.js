#!/usr/bin/env node
/**
 * execute-context-advisory.js
 * Node port of the former `skills/execute-plan-sdlc/scripts/context_advisory.sh`.
 * Combines `readSection()` (scripts/lib/config.js) with `getAdvisory()`
 * (scripts/lib/context-advisory.js), preserving the original's
 * try/catch-swallow-missing-sidecar behavior (context_advisory.sh:8-16):
 * a missing helper or unreadable sidecar is silently ignored, never fatal.
 *
 * Usage:
 *   node execute-context-advisory.js
 *
 * Behavior:
 *   - Prints the context-heaviness advisory text to stderr when the
 *     transcript-stats sidecar reports `heavy: true` (no advisory otherwise).
 *   - Prints the `execute.guardrails` array (from project config) as a single
 *     JSON line on stdout — consumed inline by the SKILL.md caller via
 *     command substitution (no --output-file manifest here, matching the
 *     original script's direct `console.log(JSON.stringify(...))` stdout).
 *
 * Exit codes:
 *   0 = success (guardrails JSON printed, advisory printed to stderr if any)
 *   2 = unexpected script crash (e.g. scripts/lib/config.js missing)
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');

const { readSection }  = require(path.join(LIB, 'config'));
const { getAdvisory }  = require(path.join(LIB, 'context-advisory'));
const { writeJsonLine } = require(path.join(LIB, 'output'));

const SKILL_NAME = 'execute-plan-sdlc';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * No flags accepted — kept for parity with the project's parseArgs+main
 * convention (scripts/skill/commit.js:65-100).
 * @param {string[]} argv
 * @returns {{}}
 */
function parseArgs(argv) {
  return {};
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Resolve the execute-guardrails array and (best-effort) context advisory.
 *
 * @param {string} cwd  Working directory to read project config from
 * @param {{ readSectionFn?: Function, getAdvisoryFn?: Function }} [deps]  Injectable for tests
 * @returns {{ guardrails: Array, advisory: string|null }}
 */
function runExecuteContextAdvisory(cwd, { readSectionFn = readSection, getAdvisoryFn = getAdvisory } = {}) {
  let advisory = null;
  try {
    advisory = getAdvisoryFn({ skill: SKILL_NAME });
  } catch (_) {
    // helper missing or sidecar unreadable — silent (mirrors context_advisory.sh:8-16)
  }

  const execute = readSectionFn(cwd, 'execute');
  const guardrails = (execute && execute.guardrails) || [];

  return { guardrails, advisory };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  parseArgs(argv);
  const { guardrails, advisory } = runExecuteContextAdvisory(process.cwd());
  if (advisory) process.stderr.write(advisory + '\n');
  writeJsonLine(guardrails);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`execute-context-advisory.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, runExecuteContextAdvisory, main };
