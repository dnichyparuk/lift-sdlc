#!/usr/bin/env node
/**
 * setup-guardrails-write.js
 * Writes the selected plan guardrails to `.sdlc/config.json` via
 * `scripts/lib/config.js`'s `writeSection`. Replaces the fragile inline
 * `node -e` block in `setup-guardrails_write.sh` (issue: legacy script
 * migration, task 11), which substituted a `<GUARDRAILS_JSON>` placeholder
 * token into a shell-quoted script string. This CLI takes the guardrails
 * array as a structured `--value` flag instead — same shape as the sibling
 * `setup-execution-guardrails-write.js` (task 10).
 *
 * Usage:
 *   node setup-guardrails-write.js --section <name> --value '<json-array>'
 *
 * Options:
 *   --section <name>   Config section to write (default: "plan")
 *   --value <json>     JSON array of guardrail objects to write
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

const { writeSection } = require(path.join(LIB, 'config'));
const { writeOutput } = require(path.join(LIB, 'output'));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let section = 'plan';
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
    errors.push('--value is required (JSON array of guardrails)');
    return { errors, guardrails: null };
  }

  let guardrails;
  try {
    guardrails = JSON.parse(parsed.value);
  } catch (e) {
    errors.push(`--value is not valid JSON: ${e.message}`);
    return { errors, guardrails: null };
  }

  if (!Array.isArray(guardrails)) {
    errors.push('--value must be a JSON array of guardrail objects');
    return { errors, guardrails: null };
  }

  return { errors, guardrails };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const projectRoot = process.cwd();
  const cli = parseArgs(argv);

  const { errors, guardrails } = validate(cli);
  if (errors.length > 0) {
    writeOutput({ errors, warnings: [] }, 'setup-guardrails-write', 1);
    return;
  }

  writeSection(projectRoot, cli.section, { guardrails });

  writeOutput(
    {
      errors: [],
      warnings: [],
      section: cli.section,
      count: guardrails.length,
      path: '.sdlc/config.json',
    },
    'setup-guardrails-write',
    0
  );
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`setup-guardrails-write.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, validate, main };
