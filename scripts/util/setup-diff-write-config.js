#!/usr/bin/env node
/**
 * setup-diff-write-config.js
 * Node port of `skills/setup-sdlc/scripts/diff_write_config.sh`, which
 * bridged two JSON blobs (`$BEFORE_JSON` / `$AFTER_JSON`) into a `node -e`
 * inline script via `mktemp` temp files, to dodge shell quoting hazards
 * with embedded quotes/newlines. Calls `computeConfigDiff()` (scripts/lib/
 * config.js) directly against argv/stdin-supplied JSON — the whole
 * mktemp/temp-file marshalling step disappears rather than being ported
 * (Windows-portability goal; no mktemp on Windows).
 *
 * Accepts `before`/`after` JSON either as two positional args or via
 * `--before <json>` / `--after <json>` flags (flags win if both forms are
 * mixed). Names follow the actual data the original script moved
 * (`$BEFORE_JSON` / `$AFTER_JSON`, diff_write_config.sh:12-23), which is
 * the pre-answers project-config snapshot vs. the post-answers snapshot —
 * not the `--project-config`/`--local-config` split that belongs to
 * setup-init.js's config *sections*.
 *
 * Usage:
 *   node setup-diff-write-config.js '<beforeJson>' '<afterJson>'
 *   node setup-diff-write-config.js --before '<beforeJson>' --after '<afterJson>'
 *
 * Output (stdout, single JSON line — the caller captures it the same way
 * the original captured `DIFF_JSON=$(...)` from the `.sh`):
 *   Success: computeConfigDiff()'s raw return shape — { changed: [...] }
 *   Usage error: {"status":"error","error":"<message>"}
 *
 * Exit codes:
 *   0 = success, diff JSON on stdout
 *   1 = user-facing validation error (missing/invalid JSON args)
 *   2 = unexpected script crash
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const path = require('node:path');
const LIB  = path.join(__dirname, '..', 'lib');

const { computeConfigDiff } = require(path.join(LIB, 'config'));
const { writeJsonLine }     = require(path.join(LIB, 'output'));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ before: string|null, after: string|null }}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  let before = null;
  let after  = null;
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--before') before = args[++i];
    else if (a === '--after') after = args[++i];
    else positionals.push(a);
  }

  // Positionals fill whichever of before/after wasn't set via flags, in order.
  if (before === null && positionals.length > 0) before = positionals.shift();
  if (after === null && positionals.length > 0) after = positionals.shift();

  return { before: before ?? null, after: after ?? null };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Parse the before/after JSON blobs and compute the diff.
 *
 * @param {string|null} beforeRaw
 * @param {string|null} afterRaw
 * @param {{ computeConfigDiffFn?: Function }} [deps]  Injectable for tests
 * @returns {{ json: object, exitCode: number }}
 */
function runSetupDiffWriteConfig(beforeRaw, afterRaw, { computeConfigDiffFn = computeConfigDiff } = {}) {
  if (!beforeRaw || !afterRaw) {
    return { json: { status: 'error', error: 'before and after JSON are both required (two positionals, or --before/--after)' }, exitCode: 1 };
  }

  let before;
  let after;
  try {
    before = JSON.parse(beforeRaw);
  } catch (e) {
    return { json: { status: 'error', error: `before is not valid JSON: ${e.message}` }, exitCode: 1 };
  }
  try {
    after = JSON.parse(afterRaw);
  } catch (e) {
    return { json: { status: 'error', error: `after is not valid JSON: ${e.message}` }, exitCode: 1 };
  }

  const diff = computeConfigDiffFn(before, after);
  return { json: diff, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { before, after } = parseArgs(argv);
  const { json, exitCode } = runSetupDiffWriteConfig(before, after);
  writeJsonLine(json, { exitCode });
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`setup-diff-write-config.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, runSetupDiffWriteConfig, main };
