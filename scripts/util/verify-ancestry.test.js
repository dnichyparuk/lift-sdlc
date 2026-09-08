'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, runVerifyAncestry } = require('./verify-ancestry');

const SCRIPT = path.join(__dirname, 'verify-ancestry.js');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs reads --new-tag and --execute-branch', () => {
  const parsed = parseArgs(['node', 'verify-ancestry.js', '--new-tag', 'v1.2.3', '--execute-branch', 'feat/x']);
  assert.strictEqual(parsed.newTag, 'v1.2.3');
  assert.strictEqual(parsed.executeBranch, 'feat/x');
  assert.deepStrictEqual(parsed.errors, []);
});

test('parseArgs leaves values null when flags are absent (no ambient env var reads)', () => {
  const parsed = parseArgs(['node', 'verify-ancestry.js']);
  assert.strictEqual(parsed.newTag, null);
  assert.strictEqual(parsed.executeBranch, null);
});

test('parseArgs reports an unknown flag', () => {
  const parsed = parseArgs(['node', 'verify-ancestry.js', '--bogus']);
  assert.match(parsed.errors[0], /Unknown parameter passed: --bogus/);
});

// ---------------------------------------------------------------------------
// runVerifyAncestry — core logic with injectable deps
// ---------------------------------------------------------------------------

test('runVerifyAncestry is a no-op (exit 0) when a flag is missing', () => {
  const spawnFn = () => { throw new Error('should not be called'); };
  const res = runVerifyAncestry(['node', 'verify-ancestry.js', '--new-tag', 'v1.0.0'], {
    spawnFn,
    existsFn: () => true,
  });
  assert.strictEqual(res.exitCode, 0);
});

test('runVerifyAncestry exits 2 when verify-tag-ancestry.js cannot be located', () => {
  const res = runVerifyAncestry(
    ['node', 'verify-ancestry.js', '--new-tag', 'v1.0.0', '--execute-branch', 'main'],
    { existsFn: () => false }
  );
  assert.strictEqual(res.exitCode, 2);
  assert.match(res.stderr, /Could not locate scripts\/util\/verify-tag-ancestry\.js/);
});

test('runVerifyAncestry invokes verify-tag-ancestry.js with --tag/--branch/--remote derived from the flags', () => {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, error: null };
  };
  const res = runVerifyAncestry(
    ['node', 'verify-ancestry.js', '--new-tag', 'v2.0.0', '--execute-branch', 'release/x'],
    { spawnFn, existsFn: () => true, targetScript: '/fake/verify-tag-ancestry.js' }
  );
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].args, [
    '/fake/verify-tag-ancestry.js', '--tag', 'v2.0.0', '--branch', 'release/x', '--remote', 'origin',
  ]);
  assert.strictEqual(res.exitCode, 0);
});

test('runVerifyAncestry translates a non-ancestor result (subprocess exit 1) into exit 1 with remediation text', () => {
  const spawnFn = () => ({ status: 1, error: null });
  const res = runVerifyAncestry(
    ['node', 'verify-ancestry.js', '--new-tag', 'v3.0.0', '--execute-branch', 'main'],
    { spawnFn, existsFn: () => true }
  );
  assert.strictEqual(res.exitCode, 1);
  assert.match(res.stderr, /Pipeline halted: tag v3\.0\.0 is not an ancestor of main/);
  assert.match(res.stderr, /git tag -d v3\.0\.0/);
});

test('runVerifyAncestry rejects an unknown flag with exit 1', () => {
  const res = runVerifyAncestry(['node', 'verify-ancestry.js', '--nope'], { existsFn: () => true });
  assert.strictEqual(res.exitCode, 1);
  assert.match(res.stderr, /Unknown parameter passed: --nope/);
});

// ---------------------------------------------------------------------------
// End-to-end CLI
// ---------------------------------------------------------------------------

test('CLI exits 0 with no output when neither flag is passed', () => {
  const res = run([]);
  assert.strictEqual(res.status, 0, res.stderr);
});

test('CLI exits 1 on an unknown flag', () => {
  const res = run(['--bad-flag']);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /Unknown parameter passed/);
});
