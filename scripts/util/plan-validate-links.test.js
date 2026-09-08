'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, 'plan-validate-links.js');

function run(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], {
    input: input !== undefined ? input : '',
    encoding: 'utf8',
    env: { ...process.env, SDLC_LINKS_OFFLINE: '1' },
  });
}

test('module exports runValidateLinksCli (re-export from the shared lib)', () => {
  const mod = require('./plan-validate-links');
  assert.strictEqual(typeof mod.runValidateLinksCli, 'function');
});

test('CLI success path: no URLs in stdin body -> exit 0, OK message on stdout', () => {
  const res = run([], 'a plain plan with no urls in it');
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /^OK: link verification passed/);
  assert.strictEqual(res.stderr, '');
});

test('CLI success path: --file flag reads body from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-validate-links-test-'));
  const filePath = path.join(dir, 'body.txt');
  fs.writeFileSync(filePath, 'no urls here either');
  try {
    const res = run(['--file', filePath]);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /^OK: link verification passed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI error path: structurally invalid URL -> exit 1, violation on stderr', () => {
  const res = run([], 'see http://[::1 for details');
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /url-invalid/);
});

test('CLI error path: unknown flag -> exit 2, usage error on stderr', () => {
  const res = run(['--bogus']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /Unknown parameter: --bogus/);
});

test('CLI error path: unreadable --file -> exit 2', () => {
  const res = run(['--file', path.join(os.tmpdir(), `does-not-exist-${Date.now()}.txt`)]);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /cannot read --file/);
});
