'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT_PATH = path.join(__dirname, 'verify-pipeline.js');

test('verify-pipeline: exports main for programmatic use', () => {
  const { main } = require('./verify-pipeline');
  assert.strictEqual(typeof main, 'function');
});

test('verify-pipeline: gh-auth-failure short-circuits the poll loop with a status:error payload', () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pipeline-fake-gh-'));
  const fakeGh = path.join(binDir, 'gh');
  // Any `gh` invocation (pr checks, auth status) fails, simulating an
  // unauthenticated/expired gh CLI with no stdout.
  fs.writeFileSync(fakeGh, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(fakeGh, 0o755);

  try {
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--pr', '123', '--timeout', '1', '--interval', '1'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      timeout: 10000,
    });

    assert.strictEqual(res.status, 0);
    const lines = res.stdout.trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, 'must emit exactly one JSON line, not loop');
    const payload = JSON.parse(lines[0]);
    assert.strictEqual(payload.status, 'error');
    assert.ok(typeof payload.reason === 'string' && payload.reason.length > 0);
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});
