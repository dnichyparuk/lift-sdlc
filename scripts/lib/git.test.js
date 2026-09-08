'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { exec, fetchPrChecks, probeGhAuth } = require('./git.js');

test('exec() does not silently truncate output larger than execSync\'s 1 MiB default maxBuffer', () => {
  // Reproduces the review-sdlc/pr-sdlc "0-byte diff" bug: a large `git diff`
  // output exceeded execSync's default 1 MiB maxBuffer, which threw
  // ERR_CHILD_PROCESS_STDOUT_MAXBUFFER — silently caught by exec() and
  // returned as null, misread downstream as "no diff content" for every file.
  const oneMiB = 1024 * 1024;
  const targetBytes = oneMiB + 100 * 1024; // safely over the 1 MiB default
  // Print `targetBytes` 'a' characters via Node itself — avoids depending on
  // a platform-specific shell builtin (yes/head) being present.
  const cmd = `node -e "process.stdout.write('a'.repeat(${targetBytes}))"`;

  const result = exec(cmd);

  assert.notStrictEqual(result, null, 'exec() must not return null for output over the old 1 MiB default');
  assert.ok(result.length >= targetBytes - 1, `expected >= ${targetBytes - 1} chars, got ${result.length}`);
});

test('exec() still returns null on a genuinely failing command', () => {
  const result = exec('node -e "process.exit(1)"');
  assert.strictEqual(result, null);
});

test('exec() rethrows on a genuinely failing command when throwOnError is set', () => {
  assert.throws(() => exec('node -e "process.exit(1)"', { throwOnError: true }));
});

test('fetchPrChecks() returns structured object distinguishing auth-failure from empty-checks', () => {
  // When prNumber is undefined/null, return empty checks with authenticated=true, errorMessage=null
  const result1 = fetchPrChecks(null);
  assert.ok(result1 && typeof result1 === 'object', 'fetchPrChecks(null) returns an object');
  assert.ok(Array.isArray(result1.checks), 'result has checks array');
  assert.strictEqual(result1.checks.length, 0, 'checks is empty');
  assert.strictEqual(result1.ghAuthenticated, true, 'ghAuthenticated is true for null prNumber');
  assert.strictEqual(result1.errorMessage, null, 'errorMessage is null for null prNumber');

  const result2 = fetchPrChecks(undefined);
  assert.ok(result2 && typeof result2 === 'object', 'fetchPrChecks(undefined) returns an object');
  assert.ok(Array.isArray(result2.checks), 'result has checks array');
  assert.strictEqual(result2.checks.length, 0, 'checks is empty');
  assert.strictEqual(result2.ghAuthenticated, true, 'ghAuthenticated is true for undefined prNumber');
  assert.strictEqual(result2.errorMessage, null, 'errorMessage is null for undefined prNumber');
});
