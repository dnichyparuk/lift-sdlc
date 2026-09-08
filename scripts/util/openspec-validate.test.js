'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { runOpenspecValidate } = require('./openspec-validate');

test('runOpenspecValidate: success path delegates to validateChangeStrict and normalizes errors', () => {
  let calledWith = null;
  const fakeValidateFn = (cwd, changeName) => {
    calledWith = { cwd, changeName };
    return { ok: true, stdout: 'Change is valid.', stderr: '', cliAvailable: true };
  };

  const result = runOpenspecValidate('/repo', 'add-widget', { validateChangeStrictFn: fakeValidateFn });

  assert.deepEqual(calledWith, { cwd: '/repo', changeName: 'add-widget' });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'Change is valid.');
  assert.deepEqual(result.errors, []);
});

test('runOpenspecValidate: error path — missing change-name argument', () => {
  const fakeValidateFn = () => {
    throw new Error('should not be called when changeName is missing');
  };

  const result = runOpenspecValidate('/repo', null, { validateChangeStrictFn: fakeValidateFn });

  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
  assert.match(result.errors[0], /change-name argument is required/);
});

test('runOpenspecValidate: error path — underlying validation failure surfaces stderr in errors[]', () => {
  const fakeValidateFn = () => ({
    ok: false,
    stdout: '',
    stderr: 'Validation failed: missing tasks.md',
    cliAvailable: true,
  });

  const result = runOpenspecValidate('/repo', 'add-widget', { validateChangeStrictFn: fakeValidateFn });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['Validation failed: missing tasks.md']);
});
