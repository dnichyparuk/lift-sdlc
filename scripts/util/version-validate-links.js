#!/usr/bin/env node
'use strict';

/**
 * version-validate-links.js — version-sdlc's thin CLI entry point for link
 * verification (issue #198, R18).
 *
 * Migrated from skills/version-sdlc/scripts/validate_links.sh. All logic
 * lives in the shared scripts/lib/validate-links-cli.js helper (also
 * consumed by plan-sdlc's, received-review-sdlc's, review-sdlc's, and
 * commit-sdlc's equivalents) — this file only wires argv to it and
 * translates the resolved exit code into process.exit.
 *
 * Usage:
 *   node version-validate-links.js [--file <path>]
 *   echo "body" | node version-validate-links.js
 *
 * Input: text via stdin, or via --file <path>.
 * Output: OK message to stdout on success; violation list to stderr on
 * broken links.
 * Exit codes: 0 = ok, 1 = link violations, 2 = usage/crash error.
 */

const { runValidateLinksCli } = require('../lib/validate-links-cli');

if (require.main === module) {
  runValidateLinksCli(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`version-validate-links.js error: ${err && err.stack || err}\n`);
      process.exit(2);
    });
}

module.exports = { runValidateLinksCli };
