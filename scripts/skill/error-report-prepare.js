#!/usr/bin/env node
/**
 * error-report-prepare.js
 * Pre-computes the manifest needed by the error-report-orchestrator agent.
 * Collects all calling-skill-supplied error context plus environment fields
 * (repository, current branch) and writes a JSON payload that the orchestrator
 * uses to draft a tooling-error GitHub issue.
 *
 * Usage:
 *   node error-report-prepare.js --skill <name> --step <step> --operation <op> \
 *     --error-text <text> [--exit-or-http-code <code>] [--error-type <type>] \
 *     [--user-intent <text>] [--args-string <args>] \
 *     [--suggested-investigation <hints>] [--output-file]
 *
 *   Long string fields may also be supplied via stdin as JSON:
 *     echo '{"errorText":"..."}' | node error-report-prepare.js --skill foo --step bar ...
 *   CLI flags take precedence over stdin fields when both are present.
 *
 * Required fields: skill, step, operation, errorText
 *
 * Exit codes:
 *   0 = success, manifest path printed to stdout (with --output-file)
 *       or manifest JSON printed to stdout (without --output-file)
 *   1 = fatal error (missing required fields), JSON with errors[] on stdout
 *   2 = unexpected script crash, message on stderr
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const path = require('node:path');
const { execSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');
const { writeOutput } = require(path.join(LIB, 'output'));

const TARGET_REPO = 'dnichyparuk/lift-sdlc';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

/**
 * Parse `--key value` and `--key=value` style flags. Unknown flags are kept.
 * The `--output-file` flag is consumed downstream by lib/output.js.
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (a === '--output-file') continue; // handled by writeOutput
    const eq = a.indexOf('=');
    let key;
    let val;
    if (eq !== -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      val = argv[i + 1];
      if (val !== undefined && !val.startsWith('--')) {
        i++;
      } else {
        val = '';
      }
    }
    out[key] = val;
  }
  return out;
}

function camelKey(k) {
  return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Read stdin synchronously when present; parse as JSON. Returns {} on absence
 * or parse failure (silent — CLI flags remain authoritative).
 */
function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {};
    const fs = require('node:fs');
    const buf = fs.readFileSync(0, 'utf8');
    if (!buf.trim()) return {};
    return JSON.parse(buf);
  } catch (_) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Environment probes
// ---------------------------------------------------------------------------

function safeExec(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (_) {
    return '';
  }
}

function detectRepository() {
  return safeExec('git remote get-url origin');
}

function detectCurrentBranch() {
  return safeExec('git rev-parse --abbrev-ref HEAD');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const cli = parseArgs(process.argv.slice(2));
  const stdin = readStdinJson();

  // Build input map: stdin first, CLI overrides.
  const input = {};
  for (const [k, v] of Object.entries(stdin)) input[k] = v;
  for (const [k, v] of Object.entries(cli)) input[camelKey(k)] = v;

  const errors = [];
  const required = ['skill', 'step', 'operation', 'errorText'];
  for (const key of required) {
    if (!input[key] || String(input[key]).trim() === '') {
      errors.push(`Missing required field: ${key}`);
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`error-report-prepare: ${errors.join('; ')}\n`);
    writeOutput({ errors, warnings: [] }, 'sdlc-error-report', 1);
    return;
  }

  const skill = String(input.skill).trim();
  const manifest = {
    skill,
    step: String(input.step).trim(),
    operation: String(input.operation).trim(),
    errorText: String(input.errorText),
    exitOrHttpCode: input.exitOrHttpCode != null ? String(input.exitOrHttpCode) : '',
    errorType: input.errorType != null ? String(input.errorType).trim() : '',
    userIntent: input.userIntent != null ? String(input.userIntent) : '',
    argsString: input.argsString != null ? String(input.argsString) : '',
    suggestedInvestigation: input.suggestedInvestigation != null
      ? String(input.suggestedInvestigation)
      : '',
    repository: detectRepository(),
    currentBranch: detectCurrentBranch(),
    timestamp: new Date().toISOString(),
    targetRepo: TARGET_REPO,
    labels: ['tooling-error', skill],
  };

  writeOutput(manifest, 'sdlc-error-report', 0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`error-report-prepare.js crashed: ${err.stack || err.message}\n`);
  process.exit(2);
}
