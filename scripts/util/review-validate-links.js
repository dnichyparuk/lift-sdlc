#!/usr/bin/env node
'use strict';

/**
 * review-validate-links.js — review-sdlc's thin CLI entry point for link
 * verification (issue #198).
 *
 * Migrated from skills/review-sdlc/scripts/validate_links.sh. All logic
 * lives in the shared scripts/lib/validate-links-cli.js helper (also
 * consumed by plan-sdlc's and commit-sdlc's equivalents) — this file only
 * wires argv to it and translates the resolved exit code into
 * process.exit.
 *
 * Usage:
 *   node review-validate-links.js [--file <path>]
 *   echo "body" | node review-validate-links.js
 *
 * Contract (mirrors skills/review-sdlc/scripts/validate_links.sh:11-23):
 *   - Input: text via stdin, or via --file <path>.
 *   - Output: OK message to stdout on success; violation list to stderr on
 *     broken links.
 * Exit codes: 0 = ok, 1 = link violations, 2 = usage/crash error.
 */

const { runValidateLinksCli } = require('../lib/validate-links-cli');

if (require.main === module) {
  runValidateLinksCli(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`review-validate-links.js error: ${err && err.stack || err}\n`);
      process.exit(2);
    });
}

module.exports = { runValidateLinksCli };
