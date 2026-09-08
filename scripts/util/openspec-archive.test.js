'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { runOpenspecArchive } = require('./openspec-archive');

test('runOpenspecArchive: success path delegates to runArchive and normalizes errors', () => {
  let calledWith = null;
  const fakeRunArchiveFn = (cwd, changeName) => {
    calledWith = { cwd, changeName };
    return { ok: true, stdout: 'Archived change.', stderr: '', cliAvailable: true };
  };

  const result = runOpenspecArchive('/repo', 'add-widget', { runArchiveFn: fakeRunArchiveFn });

  assert.deepEqual(calledWith, { cwd: '/repo', changeName: 'add-widget' });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'Archived change.');
  assert.deepEqual(result.errors, []);
});

test('runOpenspecArchive: error path — missing change-name argument', () => {
  const fakeRunArchiveFn = () => {
    throw new Error('should not be called when changeName is missing');
  };

  const result = runOpenspecArchive('/repo', null, { runArchiveFn: fakeRunArchiveFn });

  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
  assert.match(result.errors[0], /change-name argument is required/);
});

test('runOpenspecArchive: error path — underlying archive failure surfaces stderr in errors[]', () => {
  const fakeRunArchiveFn = () => ({
    ok: false,
    stdout: '',
    stderr: 'openspec CLI not found on PATH',
    cliAvailable: false,
  });

  const result = runOpenspecArchive('/repo', 'add-widget', { runArchiveFn: fakeRunArchiveFn });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['openspec CLI not found on PATH']);
});
