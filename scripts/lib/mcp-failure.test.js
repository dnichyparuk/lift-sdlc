'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'mcp-failure.js');

const { classify } = require('./mcp-failure');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('--hash: prints the first 12 hex chars of the sha256 digest, matching sha256sum | cut -c1-12', () => {
  const value = 'permission denied: destructive git command';
  const expected = crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);

  const result = run(['--hash', value]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${expected}\n`);
});

test('--hash: byte-for-byte parity with a known sha256sum | cut -c1-12 fixture', () => {
  // `printf '%s' "hello world" | sha256sum | cut -c1-12` -> b94d27b9934d
  const result = run(['--hash', 'hello world']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'b94d27b9934d\n');
});

test('--hash: empty string fixture parity (echo -n "" | sha256sum | cut -c1-12)', () => {
  const result = run(['--hash', '']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'e3b0c44298fc\n');
});

test('classify: still exported and functional after --hash addition (regression guard)', () => {
  assert.equal(classify({ httpStatus: 401 }), 'auth');
});
