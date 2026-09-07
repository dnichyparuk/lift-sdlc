'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const PIPELINE_SCRIPT = path.join(__dirname, 'pipeline.js');
const SHIP_SHIM = path.join(__dirname, 'ship.js');

function run(script, args, stateDir) {
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: stateDir },
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch (_) { /* ignore JSON parse error */ }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

test('pipeline.js: full lifecycle with custom pipeline prefix', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
  try {
    const branch = 'feature-custom';

    // 1. init
    const initRes = run(PIPELINE_SCRIPT, [
      '--pipeline', 'custom-pipe',
      'init',
      '--branch', branch,
      '--flags', JSON.stringify({ auto: true }),
      '--steps', JSON.stringify(['step1', 'step2']),
    ], tempDir);

    assert.strictEqual(initRes.status, 0, initRes.stderr);
    assert.ok(initRes.json && initRes.json.filePath);
    assert.ok(fs.existsSync(initRes.json.filePath));

    // 2. read
    const readRes1 = run(PIPELINE_SCRIPT, ['--pipeline', 'custom-pipe', 'read', '--branch', branch], tempDir);
    assert.strictEqual(readRes1.status, 0);
    assert.strictEqual(readRes1.json.pipeline, 'custom-pipe');
    assert.strictEqual(readRes1.json.steps.length, 2);
    assert.strictEqual(readRes1.json.steps[0].status, 'pending');

    // 3. start step1
    const startRes = run(PIPELINE_SCRIPT, ['--pipeline', 'custom-pipe', 'start', '--step', 'step1', '--branch', branch], tempDir);
    assert.strictEqual(startRes.status, 0);

    // 4. decide and defer
    const decideRes = run(PIPELINE_SCRIPT, ['--pipeline', 'custom-pipe', 'decide', '--step', 'step1', '--text', 'use-fast-path', '--branch', branch], tempDir);
    assert.strictEqual(decideRes.status, 0);

    const deferRes = run(PIPELINE_SCRIPT, ['--pipeline', 'custom-pipe', 'defer', '--severity', 'medium', '--file', 'foo.js', '--title', 'refactor later', '--branch', branch], tempDir);
    assert.strictEqual(deferRes.status, 0);

    // 5. complete step1
    const compRes = run(PIPELINE_SCRIPT, ['--pipeline', 'custom-pipe', 'complete', '--step', 'step1', '--result', 'step1 done', '--branch', branch], tempDir);
    assert.strictEqual(compRes.status, 0);

    // 6. suspend and resume step2
    const startStep2 = run(PIPELINE_SCRIPT, ['--pipeline', 'custom-pipe', 'start', '--step', 'step2', '--branch', branch], tempDir);
    assert.strictEqual(startStep2.status, 0);

    const suspendRes = run(PIPELINE_SCRIPT, ['--pipeline', 'custom-pipe', 'suspend', '--step', 'step2', '--question', JSON.stringify({ q: 'need token' }), '--branch', branch], tempDir);
    assert.strictEqual(suspendRes.status, 0);

    const resumeRes = run(PIPELINE_SCRIPT, ['--pipeline', 'custom-pipe', 'resume', '--step', 'step2', '--answer', JSON.stringify({ a: 'token123' }), '--branch', branch], tempDir);
    assert.strictEqual(resumeRes.status, 0);

    const skipRes = run(PIPELINE_SCRIPT, ['--pipeline', 'custom-pipe', 'skip', '--step', 'step2', '--reason', 'not needed', '--branch', branch], tempDir);
    assert.strictEqual(skipRes.status, 0);

    // 7. contract validation & cleanup-pipeline
    const cleanupRes = run(PIPELINE_SCRIPT, ['--pipeline', 'custom-pipe', 'cleanup-pipeline', '--branch', branch], tempDir);
    assert.strictEqual(cleanupRes.status, 0);
    assert.strictEqual(cleanupRes.json.currentRun.cleaned, true);
    assert.strictEqual(fs.existsSync(initRes.json.filePath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('pipeline.js: cleanup fails when steps are in_progress, succeeds with --force', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
  try {
    const branch = 'feature-abort';

    // init & start
    const initRes = run(PIPELINE_SCRIPT, ['--pipeline', 'ship', 'init', '--branch', branch, '--flags', '{}'], tempDir);
    assert.strictEqual(initRes.status, 0);

    run(PIPELINE_SCRIPT, ['--pipeline', 'ship', 'start', '--step', 'execute', '--branch', branch], tempDir);

    // Normal cleanup-pipeline should fail contract validation
    const cleanupFail = run(PIPELINE_SCRIPT, ['--pipeline', 'ship', 'cleanup-pipeline', '--branch', branch], tempDir);
    assert.strictEqual(cleanupFail.status, 1);
    assert.strictEqual(cleanupFail.json.currentRun.valid, false);
    assert.ok(fs.existsSync(initRes.json.filePath));

    // Cleanup with --force should succeed and preserve state file
    const cleanupForce = run(PIPELINE_SCRIPT, ['--pipeline', 'ship', 'cleanup-pipeline', '--force', '--branch', branch], tempDir);
    assert.strictEqual(cleanupForce.status, 0);
    assert.strictEqual(cleanupForce.json.force, true);
    assert.ok(fs.existsSync(initRes.json.filePath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('ship.js shim: delegates to pipeline.js --pipeline ship', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-shim-test-'));
  try {
    const branch = 'feature-shim';
    const initRes = run(SHIP_SHIM, ['init', '--branch', branch, '--flags', '{"auto":true}'], tempDir);
    assert.strictEqual(initRes.status, 0, initRes.stderr);
    assert.ok(initRes.json && initRes.json.filePath);

    const readRes = run(SHIP_SHIM, ['read', '--branch', branch], tempDir);
    assert.strictEqual(readRes.status, 0);
    assert.strictEqual(readRes.json.pipeline, 'ship');
    assert.strictEqual(readRes.json.flags.auto, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
