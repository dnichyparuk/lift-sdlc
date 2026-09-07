'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const { MANIFEST, extractVersion, parseArgs } = require('./scaffold-ci');
const CLI = path.join(__dirname, 'scaffold-ci.js');

function run(args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  let json = null;
  const stdout = (res.stdout || '').trim();
  if (stdout && fs.existsSync(stdout)) {
    try { json = JSON.parse(fs.readFileSync(stdout, 'utf8')); } catch (_) {
      // Ignore JSON parse errors in test helper
    }
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

test('parseArgs parses flags correctly', () => {
  assert.deepStrictEqual(parseArgs(['node', 'scaffold-ci.js']), {
    changelog: false,
    force: false,
    checkOnly: false,
  });

  assert.deepStrictEqual(parseArgs(['node', 'scaffold-ci.js', '--changelog', '--force', '--check-only']), {
    changelog: true,
    force: true,
    checkOnly: true,
  });
});

test('extractVersion parses version correctly', () => {
  const content1 = 'const RETAG_SCRIPT_VERSION = 42;';
  const regex1 = /const\s+RETAG_SCRIPT_VERSION\s*=\s*(\d+)/;
  assert.strictEqual(extractVersion(content1, regex1), 42);

  const content2 = 'unversioned content';
  assert.strictEqual(extractVersion(content2, regex1), 1);
});

test('MANIFEST entries have required properties', () => {
  assert.ok(Array.isArray(MANIFEST));
  assert.ok(MANIFEST.length >= 2);
  for (const entry of MANIFEST) {
    assert.ok(entry.src, 'entry missing src');
    assert.ok(entry.dest, 'entry missing dest');
    assert.ok(entry.versionRegex instanceof RegExp, 'entry missing versionRegex');
    assert.ok(entry.group, 'entry missing group');
  }
});

test('scaffold-ci CLI: --check-only reports file status', () => {
  const res = run(['--check-only']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.json, 'expected output manifest JSON');
  assert.ok(Array.isArray(res.json.files));
  assert.ok(res.json.files.length > 0);
  for (const file of res.json.files) {
    assert.ok(['missing', 'outdated', 'current'].includes(file.action));
  }
});

test('scaffold-ci CLI: includes changelog files when --changelog is specified', () => {
  const resNoChangelog = run(['--check-only']);
  const resChangelog = run(['--check-only', '--changelog']);

  assert.strictEqual(resNoChangelog.status, 0);
  assert.strictEqual(resChangelog.status, 0);
  assert.ok(resChangelog.json.files.length > resNoChangelog.json.files.length);
  assert.ok(resChangelog.json.files.some(f => f.group === 'changelog'));
});
