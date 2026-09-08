'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseArgs, validate } = require('./ship-init.js');

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: defaults when no flags passed', () => {
  const result = parseArgs(['node', 'ship-init.js']);
  assert.strictEqual(result.bump, 'patch');
  assert.strictEqual(result.draft, false);
  assert.strictEqual(result.auto, false);
  assert.strictEqual(result.threshold, 'high');
  assert.strictEqual(result.workspace, 'prompt');
  assert.strictEqual(result.rebase, 'auto');
  assert.strictEqual(result.quick, null);
  assert.deepStrictEqual(result.parseErrors, []);
});

test('parseArgs: --steps splits on comma and trims', () => {
  const result = parseArgs(['node', 'ship-init.js', '--steps', ' execute, commit ,pr']);
  assert.deepStrictEqual(result.steps, ['execute', 'commit', 'pr']);
});

test('parseArgs: --quick is ingested as an array', () => {
  const result = parseArgs(['node', 'ship-init.js', '--quick', 'execute,commit']);
  assert.deepStrictEqual(result.quick, ['execute', 'commit']);
});

test('parseArgs: --draft and --auto are boolean flags', () => {
  const result = parseArgs(['node', 'ship-init.js', '--draft', '--auto']);
  assert.strictEqual(result.draft, true);
  assert.strictEqual(result.auto, true);
});

test('parseArgs: --preset and --skip are hard-removed and produce parseErrors', () => {
  const preset = parseArgs(['node', 'ship-init.js', '--preset']);
  assert.ok(preset.parseErrors.some(e => e.includes('--preset is no longer accepted')));
  const skip = parseArgs(['node', 'ship-init.js', '--skip']);
  assert.ok(skip.parseErrors.some(e => e.includes('--skip is no longer accepted')));
});

test('parseArgs: --bump, --threshold, --workspace, --rebase take their values', () => {
  const result = parseArgs([
    'node', 'ship-init.js',
    '--bump', 'major',
    '--threshold', 'critical',
    '--workspace', 'worktree',
    '--rebase', 'skip',
  ]);
  assert.strictEqual(result.bump, 'major');
  assert.strictEqual(result.threshold, 'critical');
  assert.strictEqual(result.workspace, 'worktree');
  assert.strictEqual(result.rebase, 'skip');
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

function validParsed(overrides = {}) {
  return {
    steps: ['execute', 'commit', 'review', 'pr'],
    quick: null,
    bump: 'patch',
    threshold: 'high',
    workspace: 'prompt',
    rebase: 'auto',
    ...overrides,
  };
}

test('validate: passes for a fully valid parsed object', () => {
  assert.deepStrictEqual(validate(validParsed()), []);
});

test('validate: rejects empty steps array', () => {
  const errors = validate(validParsed({ steps: [] }));
  assert.ok(errors.some(e => e.includes('--steps must be a non-empty')));
});

test('validate: rejects an unknown step value', () => {
  const errors = validate(validParsed({ steps: ['execute', 'not-a-real-step'] }));
  assert.ok(errors.some(e => e.includes('invalid value "not-a-real-step"')));
});

test('validate: rejects an unknown --quick value', () => {
  const errors = validate(validParsed({ quick: ['not-a-real-step'] }));
  assert.ok(errors.some(e => e.includes('--quick contains invalid value')));
});

test('validate: rejects invalid --bump, --threshold, --workspace, --rebase', () => {
  const errors = validate(validParsed({ bump: 'x', threshold: 'x', workspace: 'x', rebase: 'x' }));
  assert.ok(errors.some(e => e.startsWith('--bump must be one of')));
  assert.ok(errors.some(e => e.startsWith('--threshold must be one of')));
  assert.ok(errors.some(e => e.startsWith('--workspace must be one of')));
  assert.ok(errors.some(e => e.startsWith('--rebase must be one of')));
});
