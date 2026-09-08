'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, runSetupDiffWriteConfig } = require('./setup-diff-write-config');

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: two positional args map to before/after in order', () => {
  const result = parseArgs(['node', 'setup-diff-write-config.js', '{"a":1}', '{"a":2}']);
  assert.deepEqual(result, { before: '{"a":1}', after: '{"a":2}' });
});

test('parseArgs: --before/--after flags', () => {
  const result = parseArgs(['node', 'setup-diff-write-config.js', '--before', '{"a":1}', '--after', '{"a":2}']);
  assert.deepEqual(result, { before: '{"a":1}', after: '{"a":2}' });
});

test('parseArgs: flags win when mixed with a leftover positional', () => {
  const result = parseArgs(['node', 'setup-diff-write-config.js', '--before', '{"a":1}', '--after', '{"a":2}', 'ignored']);
  assert.deepEqual(result, { before: '{"a":1}', after: '{"a":2}' });
});

test('parseArgs: no args given -> both null', () => {
  const result = parseArgs(['node', 'setup-diff-write-config.js']);
  assert.deepEqual(result, { before: null, after: null });
});

// ---------------------------------------------------------------------------
// runSetupDiffWriteConfig — success path
// ---------------------------------------------------------------------------

test('runSetupDiffWriteConfig: success path delegates to computeConfigDiff with parsed JSON', () => {
  let calledWith = null;
  const computeConfigDiffFn = (before, after) => {
    calledWith = { before, after };
    return { changed: [{ path: 'a', before: 1, after: 2 }], unchanged: 0 };
  };

  const { json, exitCode } = runSetupDiffWriteConfig('{"a":1}', '{"a":2}', { computeConfigDiffFn });

  assert.deepEqual(calledWith, { before: { a: 1 }, after: { a: 2 } });
  assert.equal(exitCode, 0);
  assert.deepEqual(json, { changed: [{ path: 'a', before: 1, after: 2 }], unchanged: 0 });
});

test('runSetupDiffWriteConfig: success path with real computeConfigDiff (no injected dep)', () => {
  const { json, exitCode } = runSetupDiffWriteConfig('{"a":1}', '{"a":1,"b":3}');

  assert.equal(exitCode, 0);
  assert.deepEqual(json, { changed: [{ path: 'b', before: undefined, after: 3 }], unchanged: 1 });
});

// ---------------------------------------------------------------------------
// runSetupDiffWriteConfig — error paths
// ---------------------------------------------------------------------------

test('runSetupDiffWriteConfig: error path — missing before', () => {
  const computeConfigDiffFn = () => {
    throw new Error('should not be called');
  };

  const { json, exitCode } = runSetupDiffWriteConfig(null, '{"a":2}', { computeConfigDiffFn });

  assert.equal(exitCode, 1);
  assert.equal(json.status, 'error');
  assert.match(json.error, /before and after JSON are both required/);
});

test('runSetupDiffWriteConfig: error path — missing after', () => {
  const computeConfigDiffFn = () => {
    throw new Error('should not be called');
  };

  const { json, exitCode } = runSetupDiffWriteConfig('{"a":1}', null, { computeConfigDiffFn });

  assert.equal(exitCode, 1);
  assert.equal(json.status, 'error');
  assert.match(json.error, /before and after JSON are both required/);
});

test('runSetupDiffWriteConfig: error path — before is invalid JSON', () => {
  const computeConfigDiffFn = () => {
    throw new Error('should not be called');
  };

  const { json, exitCode } = runSetupDiffWriteConfig('{not json', '{"a":2}', { computeConfigDiffFn });

  assert.equal(exitCode, 1);
  assert.equal(json.status, 'error');
  assert.match(json.error, /before is not valid JSON/);
});

test('runSetupDiffWriteConfig: error path — after is invalid JSON', () => {
  const computeConfigDiffFn = () => {
    throw new Error('should not be called');
  };

  const { json, exitCode } = runSetupDiffWriteConfig('{"a":1}', '{not json', { computeConfigDiffFn });

  assert.equal(exitCode, 1);
  assert.equal(json.status, 'error');
  assert.match(json.error, /after is not valid JSON/);
});
