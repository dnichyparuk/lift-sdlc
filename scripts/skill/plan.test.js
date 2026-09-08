'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { runExplorePack, buildLanes } = require('./plan');

// ---------------------------------------------------------------------------
// runExplorePack — SDLC_PLAN_EXPLORE_SCRIPT override (R28 test-injection hook)
// ---------------------------------------------------------------------------
// Covers the env var override introduced to avoid filesystem stubbing in
// unit tests: `process.env.SDLC_PLAN_EXPLORE_SCRIPT || path.join(__dirname,
// 'plan-explore.js')`.

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (had) {
      process.env[name] = prev;
    } else {
      delete process.env[name];
    }
  }
}

test('runExplorePack: uses SDLC_PLAN_EXPLORE_SCRIPT override when set, ignoring the default plan-explore.js', () => {
  const tmpScript = path.join(os.tmpdir(), `mock-plan-explore-${process.pid}-${Date.now()}.js`);
  const tmpOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-plan-test-'));
  const manifestPath = path.join(tmpOutDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ marker: 'from-mock-script' }) + '\n');

  // Mock script follows the real plan-explore.js --output-file contract:
  // it prints a JSON payload's file path to stdout and exits 0.
  const mockOutputPath = path.join(tmpOutDir, 'output.json');
  fs.writeFileSync(
    mockOutputPath,
    JSON.stringify({
      manifestPath,
      outDir: tmpOutDir,
      scopeHintCount: 7,
      webResearchSignal: true,
      error: null,
    }) + '\n'
  );
  fs.writeFileSync(
    tmpScript,
    `process.stdout.write(${JSON.stringify(mockOutputPath)});\n`
  );

  try {
    const result = withEnv('SDLC_PLAN_EXPLORE_SCRIPT', tmpScript, () =>
      runExplorePack(null, 'test prompt')
    );

    assert.strictEqual(result.error, null);
    assert.strictEqual(result.manifestPath, manifestPath);
    assert.strictEqual(result.outDir, tmpOutDir);
    assert.strictEqual(result.scopeHintCount, 7);
    assert.strictEqual(result.webResearchSignal, true);
  } finally {
    fs.rmSync(tmpOutDir, { recursive: true, force: true });
    fs.rmSync(tmpScript, { force: true });
  }
});

test('runExplorePack: reports "not found" error when SDLC_PLAN_EXPLORE_SCRIPT points at a missing file', () => {
  const missingScript = path.join(os.tmpdir(), `does-not-exist-${process.pid}-${Date.now()}.js`);

  const result = withEnv('SDLC_PLAN_EXPLORE_SCRIPT', missingScript, () =>
    runExplorePack(null, 'test prompt')
  );

  assert.strictEqual(result.error, 'plan-explore.js not found');
  assert.strictEqual(result.manifestPath, null);
  assert.strictEqual(result.outDir, null);
  assert.strictEqual(result.scopeHintCount, 0);
  assert.strictEqual(result.webResearchSignal, false);
});

test('runExplorePack: falls back to the default plan-explore.js when SDLC_PLAN_EXPLORE_SCRIPT is unset', () => {
  const defaultScript = path.join(__dirname, 'plan-explore.js');
  assert.ok(fs.existsSync(defaultScript), 'default plan-explore.js must exist for the fallback to resolve');

  const result = withEnv('SDLC_PLAN_EXPLORE_SCRIPT', undefined, () =>
    runExplorePack(null, 'test prompt')
  );

  // The default script is the real plan-explore.js — it should run to
  // completion (not the "not found" error the override test above exercises)
  // and return the standard five-key shape.
  assert.notStrictEqual(result.error, 'plan-explore.js not found');
  assert.ok('manifestPath' in result);
  assert.ok('outDir' in result);
  assert.ok('scopeHintCount' in result);
  assert.ok('webResearchSignal' in result);
});

// ---------------------------------------------------------------------------
// buildLanes — P16 lane fan-out, selection by lane.id (not positional slice)
// ---------------------------------------------------------------------------
// Regression coverage for the lanes.slice(0, 4) bug: guardrail-compliance and
// dimension-coverage are both conditionally present, so the dimension-coverage
// (G17) lane's index shifts depending on which lanes were dropped. A
// positional slice(0, 4) could pull the G17 lane back into the
// "warn on missing prompt template" loop and produce a duplicate warning
// (the G17 template failure is already warned separately via g17Dispatch.error).
// The fix selects lanes by `id` instead, so this suite asserts on the `id`
// field buildLanes() emits and confirms it stays stable regardless of position.

const FAKE_G17_DISPATCH = {
  subagentType: 'general-purpose',
  model: 'gemini-3.8-flash-medium',
  promptTemplatePath: '/fake/g17-dimension-coverage-prompt.md',
};

function makeProjectRoot({ withDimensions }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-plan-lanes-test-'));
  if (withDimensions) {
    const dimensionsDir = path.join(dir, '.sdlc', 'review-dimensions');
    fs.mkdirSync(dimensionsDir, { recursive: true });
    // validateAll() counts any *.md file in the dir toward `dimensions.length`
    // regardless of frontmatter validity — a minimal stub is enough.
    fs.writeFileSync(path.join(dimensionsDir, 'stub-dimension.md'), '# stub\n');
  }
  return dir;
}

test('buildLanes: guardrails absent, dimensions present — dimension-coverage lane is excluded by id regardless of position (no duplicate G17 warning)', () => {
  const projectRoot = makeProjectRoot({ withDimensions: true });
  try {
    const lanes = buildLanes(FAKE_G17_DISPATCH, [], projectRoot);

    // guardrail-compliance is dropped (no guardrails) but dimension-coverage
    // is present, so it shifts into the position slice(0, 4) used to occupy.
    assert.strictEqual(lanes.length, 4);
    assert.deepStrictEqual(
      lanes.map(l => l.id),
      ['static-structural', 'content-coverage', 'file-existence', 'dimension-coverage']
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('buildLanes: guardrails present, dimensions present — all lanes selected, output unchanged', () => {
  const projectRoot = makeProjectRoot({ withDimensions: true });
  try {
    const guardrails = [{ id: 'g1', description: 'stub guardrail', severity: 'error' }];
    const lanes = buildLanes(FAKE_G17_DISPATCH, guardrails, projectRoot);

    assert.strictEqual(lanes.length, 5);
    assert.deepStrictEqual(
      lanes.map(l => l.id),
      ['static-structural', 'content-coverage', 'file-existence', 'guardrail-compliance', 'dimension-coverage']
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('buildLanes: guardrails absent, dimensions absent — no dimension-coverage lane at all', () => {
  const projectRoot = makeProjectRoot({ withDimensions: false });
  try {
    const lanes = buildLanes(FAKE_G17_DISPATCH, [], projectRoot);

    assert.strictEqual(lanes.length, 3);
    assert.deepStrictEqual(
      lanes.map(l => l.id),
      ['static-structural', 'content-coverage', 'file-existence']
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// main() — real "missing prompt template" warning loop (plan.js:579)
// ---------------------------------------------------------------------------
// The above buildLanes() tests cover lane selection/ordering, but the actual
// bug (and its fix) lives in main()'s warning loop at plan.js:579 —
// `lanes.filter(lane => lane.id !== 'dimension-coverage').forEach(...)`.
// That predicate is not exported, so it must be exercised through main()
// itself (subprocess) rather than re-declared here: a hand-rolled copy of
// the predicate would keep passing even if the call site regressed back to
// a positional `lanes.slice(0, 4)`.
//
// Fixture: an isolated copy of plan.js + its lib/ dependencies, deliberately
// missing skills/plan-sdlc/, so every lane's promptTemplatePath — including
// dimension-coverage's (via g17Dispatch) — resolves to null. Combined with
// "guardrails absent, dimensions present" (4 total lanes, dimension-coverage
// at index 3 — see the buildLanes test above), this reproduces the exact
// shape that exposed the original slice(0, 4) bug: a buggy call site would
// sweep dimension-coverage into the loop and print a second, duplicate
// "lane \"dimension-coverage\" skipped" warning on top of the "G17 skipped"
// warning already emitted separately.

function makeIsolatedPlanScript() {
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-plan-isolated-'));
  const isolatedSkillDir = path.join(isolatedRoot, 'scripts', 'skill');
  const isolatedLibDir = path.join(isolatedRoot, 'scripts', 'lib');
  fs.mkdirSync(isolatedSkillDir, { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'lib'), isolatedLibDir, { recursive: true });
  fs.cpSync(path.join(__dirname, 'plan.js'), path.join(isolatedSkillDir, 'plan.js'));
  // No skills/plan-sdlc/ directory is created — every resolveSkillTemplate()/
  // buildG17Dispatch() workspace-relative fallback lookup misses, so every
  // lane's promptTemplatePath is null.
  return { isolatedRoot, scriptPath: path.join(isolatedSkillDir, 'plan.js') };
}

// Prompt template names resolved by resolveSkillTemplate()/buildG17Dispatch()
// under skills/plan-sdlc/ (workspace-relative fallback — see plan.js).
const LANE_TEMPLATE_NAMES = [
  'lane-static-structural-prompt.md',
  'lane-content-coverage-prompt.md',
  'lane-file-existence-prompt.md',
  'lane-guardrail-compliance-prompt.md',
];
const LENS_TEMPLATE_NAMES = [
  'lens-architecture-prompt.md',
  'lens-requirements-prompt.md',
  'lens-risk-prompt.md',
];
const G17_TEMPLATE_NAME = 'g17-dimension-coverage-prompt.md';

// Same isolated copy as makeIsolatedPlanScript(), but with a populated
// skills/plan-sdlc/ directory so every lane/lens/G17 promptTemplatePath
// resolves to a real (stub) file instead of null.
function makeIsolatedPlanScriptWithTemplates() {
  const { isolatedRoot, scriptPath } = makeIsolatedPlanScript();
  const templatesDir = path.join(isolatedRoot, 'skills', 'plan-sdlc');
  fs.mkdirSync(templatesDir, { recursive: true });
  for (const name of [...LANE_TEMPLATE_NAMES, ...LENS_TEMPLATE_NAMES, G17_TEMPLATE_NAME]) {
    fs.writeFileSync(path.join(templatesDir, name), '# stub template\n');
  }
  return { isolatedRoot, scriptPath };
}

function makeTempGitProject({ withDimensions }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-plan-main-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  if (withDimensions) {
    const dimensionsDir = path.join(dir, '.sdlc', 'review-dimensions');
    fs.mkdirSync(dimensionsDir, { recursive: true });
    fs.writeFileSync(path.join(dimensionsDir, 'stub-dimension.md'), '# stub\n');
  }
  return dir;
}

// Same SDLC_PLAN_EXPLORE_SCRIPT override contract exercised by the
// runExplorePack tests above — stands in for the real plan-explore.js so
// this test doesn't depend on its behavior.
function makeExploreStub(outDir) {
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ marker: 'stub' }) + '\n');
  const outputPath = path.join(outDir, 'explore-output.json');
  fs.writeFileSync(
    outputPath,
    JSON.stringify({
      manifestPath,
      outDir,
      scopeHintCount: 0,
      webResearchSignal: false,
      error: null,
    }) + '\n'
  );
  const scriptPath = path.join(outDir, 'mock-plan-explore.js');
  fs.writeFileSync(scriptPath, `process.stdout.write(${JSON.stringify(outputPath)});\n`);
  return scriptPath;
}

test('main(): dimension-coverage lane never receives its own missing-template warning, even when its template is also missing (regression guard for the lanes.slice(0, 4) bug)', () => {
  const { isolatedRoot, scriptPath } = makeIsolatedPlanScript();
  const repo = makeTempGitProject({ withDimensions: true });
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-plan-home-'));
  const exploreScript = makeExploreStub(repo);

  try {
    const result = spawnSync(process.execPath, [scriptPath, '--skip-config-check'], {
      cwd: repo,
      input: '',
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir, // keeps buildG17Dispatch/resolveSkillTemplate's ~/.gemini find cascade from finding a real installed template
        SDLC_STATE_DIR_OVERRIDE: path.join(repo, '.sdlc-test-state'),
        SDLC_PLAN_EXPLORE_SCRIPT: exploreScript,
      },
    });

    assert.strictEqual(result.status, 0, `expected clean exit; stderr:\n${result.stderr}`);

    // g17Dispatch's own "prompt template not found" warning still fires.
    assert.match(result.stderr, /\[plan-prepare\] G17 skipped —/);

    // Every non-G17 lane (static-structural, content-coverage,
    // file-existence — no guardrail-compliance since guardrails are absent)
    // gets exactly one skip warning.
    for (const laneName of ['static-structural', 'content-coverage', 'file-existence']) {
      const matches = result.stderr.match(new RegExp(`lane "${laneName}" skipped — prompt template not found`, 'g')) || [];
      assert.strictEqual(matches.length, 1, `expected exactly one skip warning for lane "${laneName}", got ${matches.length}. stderr:\n${result.stderr}`);
    }

    // The regression this test guards: dimension-coverage must never reach
    // the lane-warning loop, so it must never print its own "lane ... skipped"
    // line — only the separate "G17 skipped" warning above covers it.
    assert.doesNotMatch(
      result.stderr,
      /lane "dimension-coverage" skipped/,
      'dimension-coverage must not receive a duplicate missing-template warning'
    );
  } finally {
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

// Companion to the regression test above: guardrails present, dimensions
// present, and every prompt template actually resolves (unlike the
// deliberately-broken fixture above). Asserts the positive case — zero
// missing-template warnings of any kind — and that the manifest written to
// the --output-file path carries the full 5-lane set with real paths.
test('main(): guardrails present, dimensions present, all prompt templates found — zero missing-template warnings and full lane set in the manifest', () => {
  const { isolatedRoot, scriptPath } = makeIsolatedPlanScriptWithTemplates();
  const repo = makeTempGitProject({ withDimensions: true });
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-plan-home-'));
  const exploreScript = makeExploreStub(repo);

  fs.writeFileSync(
    path.join(repo, '.sdlc', 'config.json'),
    JSON.stringify({ plan: { guardrails: [{ id: 'g1', description: 'stub guardrail', severity: 'error' }] } }) + '\n'
  );

  try {
    const result = spawnSync(process.execPath, [scriptPath, '--skip-config-check'], {
      cwd: repo,
      input: '',
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir, // keeps the ~/.gemini find cascade from finding a real installed template
        SDLC_STATE_DIR_OVERRIDE: path.join(repo, '.sdlc-test-state'),
        SDLC_PLAN_EXPLORE_SCRIPT: exploreScript,
      },
    });

    assert.strictEqual(result.status, 0, `expected clean exit; stderr:\n${result.stderr}`);

    // No lane, lens, or G17 warning should fire — every template resolved.
    assert.doesNotMatch(
      result.stderr,
      /skipped — prompt template not found/,
      `expected zero missing-template warnings; stderr:\n${result.stderr}`
    );
    assert.doesNotMatch(result.stderr, /G17 skipped/, `expected no G17 warning; stderr:\n${result.stderr}`);

    const manifestPath = result.stdout.trim();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.deepStrictEqual(
      manifest.lanes.map(l => l.id),
      ['static-structural', 'content-coverage', 'file-existence', 'guardrail-compliance', 'dimension-coverage']
    );
    for (const lane of manifest.lanes) {
      assert.notStrictEqual(lane.promptTemplatePath, null, `lane "${lane.id}" should have resolved a prompt template`);
    }
  } finally {
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
