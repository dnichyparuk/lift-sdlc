'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const fs     = require('node:fs');
const os     = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'commit-validate-links.js');

function run(args, input) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', input });
}

test('commit-validate-links: exits 0 for a body with no URLs, read from stdin (success path)', () => {
  const result = run([], 'chore: tidy up docs, no links in this body');
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('commit-validate-links: prints the shared OK success line on stdout', () => {
  const result = run([], 'chore: tidy up docs, no links in this body');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^OK: link verification passed/);
});

test('commit-validate-links: exits 1 and reports the violation to stderr for a malformed URL (error path)', () => {
  const result = run([], 'See http://[bad for details');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /url-invalid/);
});

test('commit-validate-links: reads the body from --file when given', () => {
  const tmp = path.join(os.tmpdir(), `commit-validate-links-test-${process.pid}.txt`);
  fs.writeFileSync(tmp, 'docs: update readme, no links here');
  try {
    const result = run(['--file', tmp]);
    assert.equal(result.status, 0);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('commit-validate-links: exits 2 for an unreadable --file path (error path)', () => {
  const result = run(['--file', '/nonexistent/path/does-not-exist.txt']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read --file/);
});

test('commit-validate-links: exits 2 for an unknown flag', () => {
  const result = run(['--bogus'], '');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown parameter/);
});
