'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, computeSteps, mergeFlags, loadConfig, detectWorktree, resolvePlanFile, runValidation } = require('./ship.js');

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

test('parseArgs: a positional *.md path sets planFile and implies hasPlan', () => {
  const result = parseArgs(['node', 'ship.js', 'docs/plan.md']);
  assert.strictEqual(result.planFile, 'docs/plan.md');
  assert.strictEqual(result.hasPlan, true);
});

test('parseArgs: --plan-file sets hasPlan', () => {
  const result = parseArgs(['node', 'ship.js', '--plan-file', 'x.md']);
  assert.strictEqual(result.planFile, 'x.md');
  assert.strictEqual(result.hasPlan, true);
});

test('parseArgs: a non-.md positional is ignored and does not error', () => {
  const result = parseArgs(['node', 'ship.js', 'patch']);
  assert.strictEqual(result.planFile, null);
  assert.strictEqual(result.hasPlan, false);
  assert.deepStrictEqual(result.errors, []);
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

test('mergeFlags: hasPlan is derived from cli.hasPlan || cli.planFile', () => {
  const base = { auto: false, draft: false, bump: null, workspace: null, steps: null, quick: false };
  assert.strictEqual(mergeFlags({ ...base, hasPlan: false, planFile: null }, null).merged.hasPlan, false);
  assert.strictEqual(mergeFlags({ ...base, hasPlan: true, planFile: null }, null).merged.hasPlan, true);
  assert.strictEqual(mergeFlags({ ...base, hasPlan: false, planFile: 'docs/plan.md' }, null).merged.hasPlan, true);
});

// ---------------------------------------------------------------------------
// computeSteps
// ---------------------------------------------------------------------------

test('computeSteps: hasPlan true with execute in steps yields will_run and names the plan file', () => {
  const flags = { hasPlan: true, steps: ['execute'], quality: null, workspace: 'prompt', rebase: 'prompt', executeCommitWaves: false };
  const flagSources = { steps: 'cli' };
  const steps = computeSteps(flags, flagSources, { planFile: 'docs/plan.md' });
  const execute = steps.find(s => s.name === 'execute');
  assert.strictEqual(execute.status, 'will_run');
  assert.strictEqual(execute.reason, 'plan file: docs/plan.md');
  assert.ok(execute.args.includes('--plan-file "docs/plan.md"'));
});

test('computeSteps: --plan-file forwarded in args no longer produces a skipped execute step', () => {
  // Mirrors the flags mergeFlags derives from a `--plan-file` CLI invocation
  // (hasPlan implied true), as `run-workflow.js --manifest ... docs/plan.md`
  // would produce.
  const cli = parseArgs(['node', 'ship.js', '--plan-file', 'docs/plan.md']);
  const { merged: flags, sources: flagSources } = mergeFlags(
    { ...cli, auto: false, draft: false, bump: null, workspace: null, steps: ['execute'], quick: false },
    null
  );
  const steps = computeSteps(flags, flagSources, { planFile: cli.planFile });
  const execute = steps.find(s => s.name === 'execute');
  assert.notStrictEqual(execute.status, 'skipped');
  assert.strictEqual(execute.status, 'will_run');
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

// ---------------------------------------------------------------------------
// R-PLANFILE (#16): explicit-only plan path
// ---------------------------------------------------------------------------

test('parseArgs: --plan sets planFile and implies hasPlan', () => {
  const result = parseArgs(['node', 'ship.js', '--plan', 'docs/plans/x.md']);
  assert.strictEqual(result.planFile, 'docs/plans/x.md');
  assert.strictEqual(result.hasPlan, true);
  assert.deepStrictEqual(result.errors, []);
});

test('parseArgs: --plan and --plan-file without a value are errors, not silently ignored', () => {
  for (const flag of ['--plan', '--plan-file']) {
    const trailing = parseArgs(['node', 'ship.js', flag]);
    assert.ok(trailing.errors.some(e => e.startsWith(`${flag} requires a path`)), flag);
    assert.strictEqual(trailing.planFile, null);
    const beforeFlag = parseArgs(['node', 'ship.js', flag, '--auto']);
    assert.ok(beforeFlag.errors.some(e => e.startsWith(`${flag} requires a path`)), flag);
    assert.strictEqual(beforeFlag.auto, true, 'the next flag is still parsed');
  }
});

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-plan-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('resolvePlanFile: no CLI path and nothing recorded resolves to null (no directory scan)', () => {
  const errors = [];
  assert.deepStrictEqual(resolvePlanFile(null, null, errors), { planFile: null, planFileSource: null });
  assert.deepStrictEqual(errors, []);
});

test('resolvePlanFile: an existing CLI .md path resolves to its absolute path', () => {
  withTempDir((dir) => {
    const plan = path.join(dir, 'plan.md');
    fs.writeFileSync(plan, '# Plan\n');
    const errors = [];
    assert.deepStrictEqual(resolvePlanFile(plan, null, errors), { planFile: plan, planFileSource: 'cli' });
    assert.deepStrictEqual(errors, []);
  });
});

test('resolvePlanFile: the CLI path wins over the path recorded in the ship state', () => {
  withTempDir((dir) => {
    const cli = path.join(dir, 'cli.md');
    const recorded = path.join(dir, 'recorded.md');
    fs.writeFileSync(cli, '# A\n');
    fs.writeFileSync(recorded, '# B\n');
    assert.deepStrictEqual(resolvePlanFile(cli, recorded, []), { planFile: cli, planFileSource: 'cli' });
    assert.deepStrictEqual(resolvePlanFile(null, recorded, []), { planFile: recorded, planFileSource: 'state' });
  });
});

test('resolvePlanFile: a missing file, a directory and a non-.md file are rejected', () => {
  withTempDir((dir) => {
    const missing = [];
    assert.strictEqual(resolvePlanFile(path.join(dir, 'nope.md'), null, missing).planFile, null);
    assert.strictEqual(missing[0].id, 'planFileNotFound');

    const directory = [];
    assert.strictEqual(resolvePlanFile(dir, null, directory).planFile, null);
    assert.strictEqual(directory[0].id, 'planFileNotFound');

    const txt = path.join(dir, 'plan.txt');
    fs.writeFileSync(txt, 'x');
    const notMd = [];
    assert.strictEqual(resolvePlanFile(txt, null, notMd).planFile, null);
    assert.strictEqual(notMd[0].id, 'planFileNotMarkdown');
  });
});

const VALID_CONTEXT = { ghAuthenticated: true, currentBranch: 'feat/x', defaultBranch: 'main' };

test('runValidation: execute will_run without a plan file is a missingPlanFile error', () => {
  const flags = { hasPlan: true, steps: ['execute', 'commit'], quality: null, workspace: 'prompt', rebase: 'prompt', executeCommitWaves: false };
  const steps = computeSteps(flags, { steps: 'cli' }, { planFile: null });
  assert.strictEqual(steps.find(s => s.name === 'execute').reason, 'no plan file (--plan <path> required)');
  const { errors } = runValidation(flags, { steps: 'cli' }, steps, { ...VALID_CONTEXT, planFile: null });
  const err = errors.find(e => e && e.id === 'missingPlanFile');
  assert.ok(err, 'missingPlanFile expected');
  assert.ok(err.message.includes('--plan <path-to-plan.md>'));
});

test('runValidation: no missingPlanFile when a plan file is given or execute does not run', () => {
  const flags = { hasPlan: true, steps: ['execute', 'commit'], quality: null, workspace: 'prompt', rebase: 'prompt', executeCommitWaves: false };
  const withPlan = computeSteps(flags, { steps: 'cli' }, { planFile: '/abs/plan.md' });
  assert.ok(!runValidation(flags, { steps: 'cli' }, withPlan, { ...VALID_CONTEXT, planFile: '/abs/plan.md' })
    .errors.some(e => e && e.id === 'missingPlanFile'));

  const noExecute = { ...flags, steps: ['commit', 'pr'] };
  const steps = computeSteps(noExecute, { steps: 'cli' }, { planFile: null });
  assert.ok(!runValidation(noExecute, { steps: 'cli' }, steps, { ...VALID_CONTEXT, planFile: null })
    .errors.some(e => e && e.id === 'missingPlanFile'));
});

test('runValidation: an already rejected --plan does not also report missingPlanFile', () => {
  const flags = { hasPlan: true, steps: ['execute'], quality: null, workspace: 'prompt', rebase: 'prompt', executeCommitWaves: false };
  const steps = computeSteps(flags, { steps: 'cli' }, { planFile: null });
  const context = { ...VALID_CONTEXT, planFile: null };
  Object.defineProperty(context, 'planFileRejected', { value: true, enumerable: false });
  assert.ok(!runValidation(flags, { steps: 'cli' }, steps, context).errors.some(e => e && e.id === 'missingPlanFile'));
});

test('resolvePlanFile: never lists a directory or sorts by mtime', () => {
  const src = resolvePlanFile.toString();
  assert.ok(!/readdirSync|mtimeMs|plansDirectory|homedir/.test(src), 'resolvePlanFile must stay explicit-only');
});
