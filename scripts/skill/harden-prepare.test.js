'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'harden-prepare.js');
const REPO_ROOT = path.join(__dirname, '..', '..');

function runCli(args) {
  const result = spawnSync('node', [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------------------
// --failure-text and --from-issue are mutually exclusive
// ---------------------------------------------------------------------------

test('--failure-text and --from-issue together: exit 1 with message on stderr', () => {
  const result = runCli(['--failure-text', 'boom', '--from-issue', '123', '--skill', 'test-skill']);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /--failure-text and --from-issue are mutually exclusive/);
});

// ---------------------------------------------------------------------------
// Neither --failure-text nor --from-issue passed
// ---------------------------------------------------------------------------

test('neither --failure-text nor --from-issue: exit 1', () => {
  const result = runCli(['--skill', 'test-skill']);
  assert.strictEqual(result.status, 1);
});

// ---------------------------------------------------------------------------
// --failure-text with --skill only: success path
// ---------------------------------------------------------------------------

test('--failure-text with --skill only: exit 0 and a manifest path on stdout', () => {
  const result = runCli(['--failure-text', 'boom', '--skill', 'test-skill']);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout.trim(), /\.json$/);
});
