#!/usr/bin/env node
/**
 * verify-pipeline-sdlc-classify.js
 *
 * Pure deterministic classifier for failed-check logs. Maps log text to one of
 * seven categories used by the verify-pipeline-sdlc skill (R2):
 *   lint | test-failure | type-error | build-error | dependency | infra | unknown
 *
 * Usage (CLI):
 *   echo "$LOG" | node verify-pipeline-sdlc-classify.js
 *   node verify-pipeline-sdlc-classify.js --logs-file <path>
 *
 * Stdout: single JSON line — {"category":"...","signals":["..."],"routingBucket":"..."}
 *
 * No I/O, no shell-out (other than reading the log file). Exposed for unit tests.
 */

'use strict';

const fs = require('node:fs');

/**
 * Pure classifier — returns the first matching category in priority order.
 * Priority is: lint < test-failure < type-error < build-error < dependency < infra < unknown,
 * but any concrete signal short-circuits to its category.
 *
 * @param {string} text
 * @returns {{category: string, signals: string[], routingBucket: string}}
 */
function classifyLogs(text) {
  const t = String(text || '');

  const ACTIONABLE = new Set(['lint', 'test-failure', 'type-error']);
  const withBucket = (result) => ({
    ...result,
    routingBucket: ACTIONABLE.has(result.category) ? 'actionable' : 'always-proposal'
  });

  if (!t.trim()) return withBucket({ category: 'unknown', signals: [] });

  const signals = [];

  // ----- Lint signals -----
  const lintPatterns = [
    /\beslint\b/i,
    /\bprettier\b/i,
    /\brubocop\b/i,
    /\bgolangci-lint\b/i,
    /\bflake8\b/i,
    /\bpylint\b/i,
    /\bproblems?\s+\(?\d+\s+errors?,\s+\d+\s+warnings?\)?/i, // eslint summary
  ];
  for (const re of lintPatterns) {
    if (re.test(t)) signals.push(`lint:${re.source}`);
  }

  // ----- Test-failure signals -----
  const testPatterns = [
    /\b\d+\s+failing\b/i,
    /\bAssertionError\b/,
    /\bexpected\b.*\breceived\b/i,
    /FAIL\s+[\w./-]+\.(test|spec)\.[jt]sx?/,
    /Tests?:\s*\d+\s+failed/i,
    /^\s*FAILED\s+tests/m,
    /pytest:.*failed/i,
  ];
  for (const re of testPatterns) {
    if (re.test(t)) signals.push(`test:${re.source}`);
  }

  // ----- Type-error signals -----
  const typePatterns = [
    /\bTS\d{4}\b/,
    /Type\s+'.*'\s+is\s+not\s+assignable/i,
    /Property\s+'.*'\s+does\s+not\s+exist\s+on\s+type/i,
    /\bmypy\b/i,
    /\btsc\b.*\berror\b/i,
  ];
  for (const re of typePatterns) {
    if (re.test(t)) signals.push(`type:${re.source}`);
  }

  // ----- Build-error signals -----
  const buildPatterns = [
    /Cannot\s+find\s+module\b/i,
    /Module\s+not\s+found/i,
    /SyntaxError:/,
    /webpack\s+\d+\s+errors/i,
    /rollup\s+failed/i,
    /esbuild.*error/i,
  ];
  for (const re of buildPatterns) {
    if (re.test(t)) signals.push(`build:${re.source}`);
  }

  // ----- Dependency signals -----
  const depPatterns = [
    /\bnpm\s+ERR!\s+code\s+E\w+/i,
    /\bENOENT\b.*node_modules/i,
    /\bpeer\s+dep\b/i,
    /\bunable\s+to\s+resolve\s+dependency\b/i,
    /\byarn\s+install.*failed/i,
    /\bpip\s+install.*ERROR\b/i,
  ];
  for (const re of depPatterns) {
    if (re.test(t)) signals.push(`dep:${re.source}`);
  }

  // ----- Infra signals -----
  const infraPatterns = [
    /\bRunner\s+lost\s+communication\b/i,
    /\btime[ -]?out(ed)?\b/i,
    /\bunable\s+to\s+access\s+'https?:\/\//i,
    /\b502\s+Bad\s+Gateway\b/i,
    /\b503\s+Service\s+Unavailable\b/i,
    /\bExitCode:\s+143\b/, // SIGTERM kill (often runner timeout)
  ];
  for (const re of infraPatterns) {
    if (re.test(t)) signals.push(`infra:${re.source}`);
  }

  // ----- Category resolution: pick the most specific actionable category first -----
  // Order: lint > test-failure > type-error > build-error > dependency > infra
  // (lint is most actionable; infra is least)
  const has = (prefix) => signals.some((s) => s.startsWith(prefix));

  if (has('lint:')) return withBucket({ category: 'lint', signals });
  if (has('test:')) return withBucket({ category: 'test-failure', signals });
  if (has('type:')) return withBucket({ category: 'type-error', signals });
  if (has('build:')) return withBucket({ category: 'build-error', signals });
  if (has('dep:')) return withBucket({ category: 'dependency', signals });
  if (has('infra:')) return withBucket({ category: 'infra', signals });

  return withBucket({ category: 'unknown', signals });
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function main(argv) {
  let logsFile = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--logs-file') logsFile = argv[++i];
  }
  let text = '';
  if (logsFile) {
    try {
      text = fs.readFileSync(logsFile, 'utf8');
    } catch (err) {
      process.stderr.write(`classify: failed to read ${logsFile}: ${err.message}\n`);
      process.stdout.write(JSON.stringify({ category: 'unknown', signals: [], routingBucket: 'always-proposal' }) + '\n');
      return;
    }
  } else {
    text = fs.readFileSync(0, 'utf8');
  }
  const verdict = classifyLogs(text);
  process.stdout.write(JSON.stringify(verdict) + '\n');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`classify: ${err.message}\n`);
    process.stdout.write(JSON.stringify({ category: 'unknown', signals: [], routingBucket: 'always-proposal' }) + '\n');
  }
}

module.exports = { classifyLogs };
