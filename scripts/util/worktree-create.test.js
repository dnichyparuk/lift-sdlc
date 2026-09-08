'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { slugify, isValidBranchName, parseArgs } = require('./worktree-create.js');

const SCRIPT = path.join(__dirname, 'worktree-create.js');

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

test('slugify: replaces non-alphanumeric, non-hyphen characters with hyphens', () => {
  assert.strictEqual(slugify('feat/add-thing'), 'feat-add-thing');
  assert.strictEqual(slugify('a.b_c'), 'a-b-c');
  assert.strictEqual(slugify('already-safe-123'), 'already-safe-123');
});

// ---------------------------------------------------------------------------
// isValidBranchName
// ---------------------------------------------------------------------------

test('isValidBranchName: accepts alphanumeric, slash, hyphen, underscore, dot', () => {
  assert.strictEqual(isValidBranchName('feat/add-thing_v2.1'), true);
});

test('isValidBranchName: rejects shell metacharacters', () => {
  assert.strictEqual(isValidBranchName('feat; rm -rf /'), false);
  assert.strictEqual(isValidBranchName('feat && echo hi'), false);
  assert.strictEqual(isValidBranchName('feat`whoami`'), false);
});

test('isValidBranchName: rejects path traversal sequences', () => {
  assert.strictEqual(isValidBranchName('feat/../../etc'), false);
});

test('isValidBranchName: rejects names ending in .lock', () => {
  assert.strictEqual(isValidBranchName('feat/thing.lock'), false);
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: extracts --name', () => {
  const result = parseArgs(['node', 'worktree-create.js', '--name', 'feat/x']);
  assert.strictEqual(result.name, 'feat/x');
});

test('parseArgs: defaults to null when --name is absent', () => {
  const result = parseArgs(['node', 'worktree-create.js']);
  assert.strictEqual(result.name, null);
});

// ---------------------------------------------------------------------------
// CLI (subprocess) — validation-only fail paths that never touch git
// ---------------------------------------------------------------------------

test('CLI: missing --name -> exit 1, JSON error on stdout', () => {
  const result = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.match(output.error, /Missing required argument/);
});

test('CLI: invalid branch name -> exit 1, JSON error on stdout', () => {
  const result = spawnSync('node', [SCRIPT, '--name', 'feat; rm -rf /'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.match(output.error, /Invalid branch name/);
});
