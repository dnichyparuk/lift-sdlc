'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, runOpenspecTasks } = require('./openspec-tasks');

const SCRIPT = path.join(__dirname, 'openspec-tasks.js');

test('parseArgs: --change flag', () => {
  assert.deepEqual(parseArgs(['node', 'openspec-tasks.js', '--change', 'add-widget']), { change: 'add-widget', unknown: null });
});

test('parseArgs: --name alias (matches openspec_tasks_wrapper.sh:21-45)', () => {
  assert.deepEqual(parseArgs(['node', 'openspec-tasks.js', '--name', 'add-widget']), { change: 'add-widget', unknown: null });
});

test('parseArgs: no flags -> change is null', () => {
  assert.deepEqual(parseArgs(['node', 'openspec-tasks.js']), { change: null, unknown: null });
});

test('parseArgs: unrecognized flag is captured as unknown', () => {
  assert.deepEqual(parseArgs(['node', 'openspec-tasks.js', '--chnage', 'foo']), { change: null, unknown: '--chnage' });
});

test('runOpenspecTasks: success path — resolves path via path.join and parses tasks.md content', () => {
  let existsCalledWith = null;
  let readCalledWith = null;
  const existsSyncFn = (p) => { existsCalledWith = p; return true; };
  const readFileSyncFn = (p, enc) => { readCalledWith = { p, enc }; return '- [ ] do the thing\n- [x] done thing\n'; };
  const parseTasksFn = (content) => {
    assert.equal(content, '- [ ] do the thing\n- [x] done thing\n');
    return [{ ref: 'do-the-thing-abc123', line: 1, title: 'do the thing', indent: 0, done: false }];
  };

  const { json, exitCode } = runOpenspecTasks('/repo', 'add-widget', { existsSyncFn, readFileSyncFn, parseTasksFn });

  assert.equal(existsCalledWith, path.join('/repo', 'openspec', 'changes', 'add-widget', 'tasks.md'));
  assert.equal(readCalledWith.p, path.join('/repo', 'openspec', 'changes', 'add-widget', 'tasks.md'));
  assert.equal(readCalledWith.enc, 'utf8');
  assert.equal(exitCode, 0);
  assert.equal(json.status, 'success');
  assert.equal(json.tasks.length, 1);
  assert.equal(json.tasks[0].done, false);
});

test('runOpenspecTasks: error path — missing --change/--name', () => {
  const { json, exitCode } = runOpenspecTasks('/repo', null);

  assert.equal(exitCode, 1);
  assert.equal(json.status, 'error');
  assert.match(json.error, /--change \(or --name\) is required/);
});

test('runOpenspecTasks: error path — tasks.md does not exist', () => {
  const existsSyncFn = () => false;
  const readFileSyncFn = () => {
    throw new Error('should not be called when file does not exist');
  };

  const { json, exitCode } = runOpenspecTasks('/repo', 'missing-change', { existsSyncFn, readFileSyncFn });

  assert.equal(exitCode, 1);
  assert.equal(json.status, 'error');
  assert.match(json.error, /file does not exist/);
  assert.match(json.error, /missing-change/);
});

test('CLI: unknown flag (--chnage typo) exits 1 with the unknown-parameter message on stderr, not the misleading --change-required error', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--chnage', 'foo'], { encoding: 'utf8' });

  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown parameter passed: --chnage/);
  assert.equal(res.stdout, '');
});
