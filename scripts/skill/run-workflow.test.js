'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'run-workflow.js');
const { parseArgs, resolveManifest } = require('./run-workflow');

test('parseArgs: extracts manifest and output-file and forwards other args', () => {
  const argv = ['node', 'run-workflow.js', '--manifest', 'skills/ship-sdlc/pipeline.json', '--output-file', '--dry-run', '--auto'];
  const res = parseArgs(argv);

  assert.strictEqual(res.manifestPath, 'skills/ship-sdlc/pipeline.json');
  assert.strictEqual(res.outputFile, true);
  assert.deepStrictEqual(res.forwarded, ['--output-file', '--dry-run', '--auto']);
});

test('resolveManifest: finds manifest relative to plugin root', () => {
  const resolved = resolveManifest('skills/ship-sdlc/pipeline.json');
  assert.ok(resolved);
  assert.ok(resolved.endsWith(path.join('skills', 'ship-sdlc', 'pipeline.json')));
});

test('run-workflow.js CLI: fails with exit code 2 when --manifest is missing', () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(res.status, 2);
  assert.ok(res.stderr.includes('--manifest <path> is required'));
});
