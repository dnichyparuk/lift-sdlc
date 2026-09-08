'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, runOpenspecTaskInfo } = require('./openspec-task-info');

const SCRIPT = path.join(__dirname, 'openspec-task-info.js');

test('parseArgs: --change --ref --line --title as ordinary flags (Key Decision 1)', () => {
  const result = parseArgs(['node', 'openspec-task-info.js', '--change', 'add-widget', '--ref', 'ref-abc123', '--line', '12', '--title', 'Do the thing']);
  assert.deepEqual(result, { change: 'add-widget', ref: 'ref-abc123', line: '12', title: 'Do the thing', unknown: null });
});

test('parseArgs: only --change and --ref given -> line/title are null', () => {
  const result = parseArgs(['node', 'openspec-task-info.js', '--change', 'add-widget', '--ref', 'ref-abc123']);
  assert.deepEqual(result, { change: 'add-widget', ref: 'ref-abc123', line: null, title: null, unknown: null });
});

test('parseArgs: unrecognized flag is captured as unknown', () => {
  const result = parseArgs(['node', 'openspec-task-info.js', '--chnage', 'foo']);
  assert.deepEqual(result, { change: null, ref: null, line: null, title: null, unknown: '--chnage' });
});

test('runOpenspecTaskInfo: success path — delegates to markTaskDone with numeric line and title', () => {
  let calledWith = null;
  const markTaskDoneFn = (change, ref, opts) => {
    calledWith = { change, ref, opts };
    return { changed: true, reason: null, line: 12 };
  };

  const { json, exitCode } = runOpenspecTaskInfo('add-widget', 'ref-abc123', '12', 'Do the thing', { markTaskDoneFn });

  assert.deepEqual(calledWith, {
    change: 'add-widget',
    ref: 'ref-abc123',
    opts: { line: 12, title: 'Do the thing' },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(json, { changed: true, reason: null, line: 12 });
});

test('runOpenspecTaskInfo: success path — omitted --line/--title become undefined (mirrors openspec_wrapper.sh env-var fallback)', () => {
  let calledWith = null;
  const markTaskDoneFn = (change, ref, opts) => {
    calledWith = { change, ref, opts };
    return { changed: false, reason: 'not-found', line: null };
  };

  const { json, exitCode } = runOpenspecTaskInfo('add-widget', 'ref-abc123', null, null, { markTaskDoneFn });

  assert.deepEqual(calledWith.opts, { line: undefined, title: undefined });
  assert.equal(exitCode, 0);
  assert.equal(json.reason, 'not-found');
});

test('runOpenspecTaskInfo: exit 0 even when markTaskDone reports a non-fatal failure reason (SKILL.md Step 5d-bis: non-blocking)', () => {
  const markTaskDoneFn = () => ({ changed: false, reason: 'io-error', line: null });

  const { json, exitCode } = runOpenspecTaskInfo('add-widget', 'ref-abc123', null, null, { markTaskDoneFn });

  assert.equal(exitCode, 0);
  assert.equal(json.reason, 'io-error');
});

test('runOpenspecTaskInfo: error path — missing --change', () => {
  const markTaskDoneFn = () => {
    throw new Error('should not be called');
  };

  const { json, exitCode } = runOpenspecTaskInfo(null, 'ref-abc123', null, null, { markTaskDoneFn });

  assert.equal(exitCode, 1);
  assert.equal(json.status, 'error');
  assert.match(json.error, /--change and --ref are required/);
});

test('CLI: unknown flag (--chnage typo) exits 1 with the unknown-parameter message on stderr, not the misleading --change-required error', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--chnage', 'foo'], { encoding: 'utf8' });

  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown parameter passed: --chnage/);
  assert.equal(res.stdout, '');
});

test('runOpenspecTaskInfo: error path — missing --ref', () => {
  const markTaskDoneFn = () => {
    throw new Error('should not be called');
  };

  const { json, exitCode } = runOpenspecTaskInfo('add-widget', null, null, null, { markTaskDoneFn });

  assert.equal(exitCode, 1);
  assert.equal(json.status, 'error');
  assert.match(json.error, /--change and --ref are required/);
});
