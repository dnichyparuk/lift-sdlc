#!/usr/bin/env node
/**
 * validate-dimension.js
 *
 * Node port of skills/harden-sdlc/scripts/validate_dimension.sh — a direct
 * 1:1 move of its inline `node -e` block into a real file. Zero new logic:
 * all validation is delegated to the pre-existing validateDimensionFile()
 * from scripts/lib/dimensions.js, exactly as the shell original did.
 *
 * Usage:
 *   node validate-dimension.js <file-path>
 *
 * Exit codes:
 *   0 = file is valid (warnings, if any, are printed to stdout)
 *   1 = usage error (no file-path given) or the file does not exist
 *   2 = validation errors found in the file
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs = require('node:fs');
const { validateDimensionFile } = require('../lib/dimensions.js');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv  Full argv (process.argv shape).
 * @returns {{target:string|null, errors:string[]}}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const errors = [];
  const target = args[0] || null;

  if (!target) {
    errors.push('Usage: validate-dimension.js <file-path>');
  }

  return { target, errors };
}

// ---------------------------------------------------------------------------
// Core (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {{existsFn?:Function, validateFn?:Function}} [deps]
 * @returns {{exitCode:number, stdout:string, stderr:string}}
 */
function runValidateDimension(argv, { existsFn = fs.existsSync, validateFn = validateDimensionFile } = {}) {
  const { target, errors: usageErrors } = parseArgs(argv);
  let stdout = '';
  let stderr = '';

  if (usageErrors.length > 0) {
    return { exitCode: 1, stdout, stderr: usageErrors.join('\n') + '\n' };
  }

  if (!existsFn(target)) {
    return { exitCode: 1, stdout, stderr: `File not found: ${target}\n` };
  }

  const { errors, warnings } = validateFn(target);

  if (warnings && warnings.length > 0) {
    for (const w of warnings) {
      stdout += `Warning (${w.check}): ${w.message}${w.line ? ' at line ' + w.line : ''}\n`;
    }
  }

  if (errors && errors.length > 0) {
    for (const e of errors) {
      stderr += `Error (${e.check}): ${e.message}${e.line ? ' at line ' + e.line : ''}\n`;
    }
    return { exitCode: 2, stdout, stderr };
  }

  stdout += 'Dimension file is valid.\n';
  return { exitCode: 0, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { exitCode, stdout, stderr } = runValidateDimension(argv);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

module.exports = { parseArgs, runValidateDimension };

if (require.main === module) {
  main(process.argv);
}
