'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const { parseArgs } = require('./version.js');

// parseArgs receives raw process.argv (argv[0]=node, argv[1]=script), so
// every call below prepends two placeholder entries that argv.slice(2) drops.
function parse(...args) {
  return parseArgs(['node', 'version.js', ...args]);
}

test('parseArgs: no flags returns all-default shape', () => {
  const r = parse();
  assert.strictEqual(r.init, false);
  assert.strictEqual(r.requestedBump, null);
  assert.strictEqual(r.preLabel, null);
  assert.strictEqual(r.noPush, false);
  assert.strictEqual(r.changelog, false);
  assert.strictEqual(r.hotfix, false);
  assert.strictEqual(r.auto, false);
  assert.strictEqual(r.retag, false);
  assert.strictEqual(r.fileOverride, null);
  assert.strictEqual(r.expectedBranch, null);
  assert.deepStrictEqual(r.warnings, []);
  assert.deepStrictEqual(r.errors, []);
});

test('parseArgs: positional major|minor|patch sets requestedBump', () => {
  assert.strictEqual(parse('major').requestedBump, 'major');
  assert.strictEqual(parse('minor').requestedBump, 'minor');
  assert.strictEqual(parse('patch').requestedBump, 'patch');
});

test('parseArgs: --init sets init true', () => {
  assert.strictEqual(parse('--init').init, true);
});

test('parseArgs: --pre <label> sets preLabel and marks it explicit', () => {
  const r = parse('--pre', 'beta');
  assert.strictEqual(r.preLabel, 'beta');
  assert.strictEqual(r.preLabelExplicit, true);
  assert.deepStrictEqual(r.errors, []);
});

test('parseArgs: --pre with an invalid label emits an error and leaves preLabel unset', () => {
  const r = parse('--pre', 'Not_Valid!');
  assert.strictEqual(r.preLabel, null);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0], /Invalid --pre label/);
});

test('parseArgs: boolean flags --no-push, --changelog, --hotfix, --retag, --auto', () => {
  const r = parse('--no-push', '--changelog', '--hotfix', '--retag', '--auto');
  assert.strictEqual(r.noPush, true);
  assert.strictEqual(r.changelog, true);
  assert.strictEqual(r.hotfix, true);
  assert.strictEqual(r.retag, true);
  assert.strictEqual(r.auto, true);
});

test('parseArgs: --file <path> sets fileOverride', () => {
  assert.strictEqual(parse('--file', '/tmp/VERSION').fileOverride, '/tmp/VERSION');
});

test('parseArgs: --expected-branch <name> sets expectedBranch', () => {
  // Covers the line touched by the ESLint 8->10 migration in this diff
  // (removal of a now-unneeded `eslint-disable-next-line no-use-before-define`).
  assert.strictEqual(parse('--expected-branch', 'release/1.2').expectedBranch, 'release/1.2');
});

test('parseArgs: --output-file is a recognized no-op boolean flag', () => {
  const r = parse('--output-file');
  assert.deepStrictEqual(r.warnings, []);
  assert.deepStrictEqual(r.errors, []);
});

test('parseArgs: unknown flag is collected as a warning, not an error', () => {
  const r = parse('--bogus-flag');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /Unknown flag: --bogus-flag/);
});

test('parseArgs: label-form positional (e.g. "rc") is sugar for patch + --pre <label>', () => {
  const r = parse('rc');
  assert.strictEqual(r.requestedBump, 'patch');
  assert.strictEqual(r.preLabel, 'rc');
  assert.strictEqual(r.bumpFromLabel, true);
});

test('parseArgs: explicit --pre wins over a label-form positional', () => {
  const r = parse('rc', '--pre', 'beta');
  assert.strictEqual(r.preLabel, 'beta');
});

test('parseArgs: unrecognized non-flag token is collected as an error', () => {
  const r = parse('not-a-real-token-123');
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0], /Unrecognized argument/);
});

test('parseArgs: --bump <value> flag sets requestedBump and bumpFromFlag', () => {
  const r = parse('--bump', 'minor');
  assert.strictEqual(r.requestedBump, 'minor');
  assert.strictEqual(r.bumpFromFlag, true);
  assert.strictEqual(r.bumpFromLabel, false);
});

test('parseArgs: --bump=<value> equals-form is accepted', () => {
  assert.strictEqual(parse('--bump=major').requestedBump, 'major');
});

test('parseArgs: --bump with a label value is sugar for patch + --pre <label>', () => {
  const r = parse('--bump', 'rc');
  assert.strictEqual(r.requestedBump, 'patch');
  assert.strictEqual(r.preLabel, 'rc');
  assert.strictEqual(r.bumpFromLabel, true);
});

test('parseArgs: --bump with an invalid value emits a structured error', () => {
  const r = parse('--bump', 'not_a_bump_or_label!');
  assert.strictEqual(r.requestedBump, null);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0], /Invalid --bump value/);
});

test('parseArgs: positional bump followed by --bump flag raises bumpFlagConflict', () => {
  const r = parse('major', '--bump', 'minor');
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].id, 'bumpFlagConflict');
});

test('parseArgs: --bump flag followed by positional bump raises bumpFlagConflict', () => {
  const r = parse('--bump', 'minor', 'major');
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].id, 'bumpFlagConflict');
});

test('parseArgs: --bump specified twice raises bumpFlagConflict', () => {
  const r = parse('--bump', 'minor', '--bump', 'major');
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].id, 'bumpFlagConflict');
});

test('parseArgs: --bump flag followed by a positional label raises bumpFlagConflict', () => {
  const r = parse('--bump', 'minor', 'rc');
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].id, 'bumpFlagConflict');
});
