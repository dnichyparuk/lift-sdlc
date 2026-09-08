#!/usr/bin/env node
/**
 * validate-commit-subject.js
 * Direct Node port of commit-sdlc/scripts/validate_subject.sh — validates a
 * commit subject line against a regex pattern (commitConfig.subjectPattern).
 *
 * Usage:
 *   node validate-commit-subject.js <pattern> <subject>
 *
 * Exit codes:
 *   0 = subject matches pattern
 *   1 = subject does not match pattern
 *
 * Zero npm dependencies — Node.js built-ins only.
 */

'use strict';

const USAGE = 'usage: validate-commit-subject.js <pattern> <subject>';

/**
 * @param {string[]} argv  process.argv
 * @returns {{ pattern: string|undefined, subject: string|undefined }}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  return { pattern: args[0], subject: args[1] };
}

/**
 * @param {string[]} argv  process.argv
 */
function main(argv) {
  const { pattern, subject } = parseArgs(argv);
  if (typeof subject !== 'string' || typeof pattern !== 'string') {
    console.error(USAGE);
    process.exit(1);
    return;
  }
  let re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    console.error(`invalid pattern: ${e.message}`);
    process.exit(1);
    return;
  }
  if (!re.test(subject)) {
    process.exit(1);
    return;
  }
  process.exit(0);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { parseArgs, main };
