'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'run-workflow.js');
const { parseArgs, resolveManifest } = require('./run-workflow');

test('parseArgs: extracts manifest and forwards other args', () => {
  const argv = ['node', 'run-workflow.js', '--manifest', 'skills/ship-sdlc/pipeline.json', '--output-file', '--dry-run', '--auto'];
  const res = parseArgs(argv);

  assert.strictEqual(res.manifestPath, 'skills/ship-sdlc/pipeline.json');
  assert.deepStrictEqual(res.forwarded, ['--output-file', '--dry-run', '--auto']);
});

test('parseArgs: handles trailing --manifest gracefully without forwarding', () => {
  const argv = ['node', 'run-workflow.js', '--dry-run', '--manifest'];
  const res = parseArgs(argv);

  assert.strictEqual(res.manifestPath, null);
  assert.deepStrictEqual(res.forwarded, ['--dry-run']);
});

test('resolveManifest: finds manifest relative to plugin root', () => {
  const resolved = resolveManifest('skills/ship-sdlc/pipeline.json');
  assert.ok(resolved);
  assert.ok(resolved.endsWith(path.join('skills', 'ship-sdlc', 'pipeline.json')));
});

test('run-workflow.js CLI: fails with exit code 1 when --manifest is missing', () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
  assert.ok(res.stderr.includes('--manifest <path> is required'));
});

test('run-workflow.js CLI: fails with exit code 1 when manifest file not found', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--manifest', 'non-existent-manifest.json'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
  assert.ok(res.stderr.includes('manifest file not found'));
});

test('run-workflow.js CLI: fails with exit code 1 when manifest is invalid JSON', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-test-'));
  const badJson = path.join(tempDir, 'bad.json');
  fs.writeFileSync(badJson, '{ not-valid-json', 'utf8');

  try {
    const res = spawnSync(process.execPath, [SCRIPT, '--manifest', badJson], { encoding: 'utf8' });
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('invalid manifest JSON'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('run-workflow.js CLI: fails with exit code 1 when manifest missing prepareScript', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-test-'));
  const noPrepare = path.join(tempDir, 'no-prepare.json');
  fs.writeFileSync(noPrepare, JSON.stringify({ name: 'test' }), 'utf8');

  try {
    const res = spawnSync(process.execPath, [SCRIPT, '--manifest', noPrepare], { encoding: 'utf8' });
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('manifest missing "prepareScript"'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('run-workflow.js CLI: happy path executes prepareScript and forwards arguments', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-happy-'));
  const mockScript = path.join(tempDir, 'mock-prepare.js');
  fs.writeFileSync(mockScript, `
    const args = process.argv.slice(2);
    process.stdout.write("MOCK_OUTPUT:" + args.join(',') + "\\n");
    process.exit(0);
  `, 'utf8');

  const manifestFile = path.join(tempDir, 'pipeline.json');
  fs.writeFileSync(manifestFile, JSON.stringify({
    pipeline: 'test-pipe',
    prepareScript: mockScript,
  }), 'utf8');

  try {
    const res = spawnSync(process.execPath, [SCRIPT, '--manifest', manifestFile, '--flag1', 'val1'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes('MOCK_OUTPUT:--flag1,val1'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

