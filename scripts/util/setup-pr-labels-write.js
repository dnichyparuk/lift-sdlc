#!/usr/bin/env node
/**
 * setup-pr-labels-write.js
 * Merges the built PR-labels block into the existing `pr` config section
 * (.sdlc/config.json) via `scripts/lib/config.js`'s `readSection`/`writeSection`,
 * preserving sibling keys such as `titlePattern` or `allowedTypes`. Replaces
 * the fragile inline `node -e` block in `setup-pr-labels_write.sh` (issue:
 * legacy script migration, task 11), which read its payload off
 * `process.argv[1]`. This CLI takes the labels block as a structured
 * `--value` flag instead — same shape as the sibling
 * `setup-execution-guardrails-write.js` (task 10) and
 * `setup-guardrails-write.js` (task 11).
 *
 * Usage:
 *   node setup-pr-labels-write.js --section <name> --value '<json-object>'
 *
 * Options:
 *   --section <name>   Config section to merge into (default: "pr")
 *   --value <json>     JSON object — the labels block ({ mode, rules? })
 *
 * Exit codes:
 *   0 = success, JSON manifest path on stdout
 *   1 = validation error (missing/invalid --value), JSON with non-empty errors[] on stdout
 *   2 = unexpected script crash, message on stderr
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');

const { readSection, writeSection } = require(path.join(LIB, 'config'));
const { writeOutput } = require(path.join(LIB, 'output'));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let section = 'pr';
  let value = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--section' && args[i + 1]) {
      section = args[++i];
    } else if (a === '--value' && args[i + 1]) {
      value = args[++i];
    }
  }

  return { section, value };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(parsed) {
  const errors = [];

  if (!parsed.section) {
    errors.push('--section is required');
  }

  if (parsed.value === null) {
    errors.push('--value is required (JSON object — the labels block)');
    return { errors, labels: null };
  }

  let labels;
  try {
    labels = JSON.parse(parsed.value);
  } catch (e) {
    errors.push(`--value is not valid JSON: ${e.message}`);
    return { errors, labels: null };
  }

  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) {
    errors.push('--value must be a JSON object (the labels block)');
    return { errors, labels: null };
  }

  return { errors, labels };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const projectRoot = process.cwd();
  const cli = parseArgs(argv);

  const { errors, labels } = validate(cli);
  if (errors.length > 0) {
    writeOutput({ errors, warnings: [] }, 'setup-pr-labels-write', 1);
    return;
  }

  const current = readSection(projectRoot, cli.section) || {};
  const next = { ...current, labels };
  writeSection(projectRoot, cli.section, next);

  writeOutput(
    {
      errors: [],
      warnings: [],
      section: cli.section,
      path: '.sdlc/config.json',
    },
    'setup-pr-labels-write',
    0
  );
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`setup-pr-labels-write.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, validate, main };
