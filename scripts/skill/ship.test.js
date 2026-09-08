'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, computeSteps, mergeFlags, loadConfig, detectWorktree } = require('./ship.js');

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: defaults when no flags passed', () => {
  const result = parseArgs(['node', 'ship.js']);
  assert.strictEqual(result.hasPlan, false);
  assert.strictEqual(result.auto, false);
  assert.strictEqual(result.steps, null);
  assert.strictEqual(result.bump, null);
  assert.deepStrictEqual(result.errors, []);
});

test('parseArgs: --steps splits on comma and trims', () => {
  const result = parseArgs(['node', 'ship.js', '--steps', ' execute, commit ,pr']);
  assert.deepStrictEqual(result.steps, ['execute', 'commit', 'pr']);
});

test('parseArgs: --bump accepts major|minor|patch and pre-release labels', () => {
  assert.strictEqual(parseArgs(['node', 'ship.js', '--bump', 'patch']).errors.length, 0);
  assert.strictEqual(parseArgs(['node', 'ship.js', '--bump', 'rc']).errors.length, 0);
});

test('parseArgs: --bump rejects an invalid value', () => {
  const result = parseArgs(['node', 'ship.js', '--bump', 'not-a-real-bump-type!']);
  assert.ok(result.errors.some(e => e.includes('--bump')));
});

test('parseArgs: --preset and --skip are hard-removed and error', () => {
  const preset = parseArgs(['node', 'ship.js', '--preset', 'balanced']);
  assert.ok(preset.errors.some(e => e.includes('--preset is no longer accepted')));
  const skip = parseArgs(['node', 'ship.js', '--skip', 'review']);
  assert.ok(skip.errors.some(e => e.includes('--skip is no longer accepted')));
});

test('parseArgs: --branch and --tree are mutually exclusive shortcuts', () => {
  const result = parseArgs(['node', 'ship.js', '--branch', '--tree']);
  assert.ok(result.errors.some(e => e.includes('Cannot combine --branch and --tree')));
});

test('parseArgs: --branch shortcut resolves to workspace "branch"', () => {
  const result = parseArgs(['node', 'ship.js', '--branch']);
  assert.strictEqual(result.workspace, 'branch');
});

test('parseArgs: --ttl-days requires an integer', () => {
  const bad = parseArgs(['node', 'ship.js', '--ttl-days', 'not-a-number']);
  assert.ok(bad.errors.some(e => e.includes('--ttl-days requires an integer')));
  const good = parseArgs(['node', 'ship.js', '--ttl-days', '7']);
  assert.strictEqual(good.ttlDays, 7);
  assert.strictEqual(good.errors.length, 0);
});

// ---------------------------------------------------------------------------
// mergeFlags
// ---------------------------------------------------------------------------

test('mergeFlags: CLI boolean true overrides config and default', () => {
  const result = mergeFlags({ auto: true, draft: false, bump: null, workspace: null, steps: null, quick: false }, { auto: false });
  assert.strictEqual(result.merged.auto, true);
  assert.strictEqual(result.sources.auto, 'cli');
});

test('mergeFlags: config value used when CLI omits a boolean', () => {
  const result = mergeFlags({ auto: false, draft: false, bump: null, workspace: null, steps: null, quick: false }, { draft: true });
  assert.strictEqual(result.merged.draft, true);
  assert.strictEqual(result.sources.draft, 'config');
});

test('mergeFlags: built-in default used when neither CLI nor config set a value', () => {
  const result = mergeFlags({ auto: false, draft: false, bump: null, workspace: null, steps: null, quick: false }, null);
  assert.strictEqual(result.merged.bump, 'patch');
  assert.strictEqual(result.sources.bump, 'default');
});

test('mergeFlags: CLI --steps fully replaces config steps', () => {
  const result = mergeFlags(
    { auto: false, draft: false, bump: null, workspace: null, steps: ['pr'], quick: false },
    { steps: ['execute', 'commit', 'review'] }
  );
  assert.deepStrictEqual(result.merged.steps, ['pr']);
  assert.strictEqual(result.sources.steps, 'cli');
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

test('loadConfig: returns { config: null, source: "defaults" } when no local.json exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-loadconfig-'));
  try {
    const result = loadConfig(tmp);
    assert.strictEqual(result.config, null);
    assert.strictEqual(result.source, 'defaults');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig: reads the ship section from .sdlc/local.json when present', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-loadconfig-'));
  try {
    fs.mkdirSync(path.join(tmp, '.sdlc'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.sdlc', 'local.json'),
      JSON.stringify({ ship: { bump: 'minor', draft: true } })
    );
    const result = loadConfig(tmp);
    assert.deepStrictEqual(result.config, { bump: 'minor', draft: true });
    assert.strictEqual(result.source, '.sdlc/local.json');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// detectWorktree
// ---------------------------------------------------------------------------

test('detectWorktree: returns a result shape with inLinkedWorktree and mainWorktreePath', () => {
  // Exercises the real function against this repo's actual worktree state —
  // a smoke test confirming it runs without throwing and returns the expected
  // shape, not a claim about which specific worktree mode this repo is in.
  const result = detectWorktree(process.cwd());
  assert.strictEqual(typeof result.inLinkedWorktree, 'boolean');
  assert.ok(typeof result.mainWorktreePath === 'string' || result.mainWorktreePath === null);
});
