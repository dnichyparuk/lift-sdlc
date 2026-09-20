#!/usr/bin/env node
/**
 * simulate-learning-loop.js
 *
 * Hermetic end-to-end simulation of the complete self-learning loop inside an
 * isolated temporary git repository fixture with a local bare remote origin.
 *
 * Full lifecycle path verified:
 *   1. capture-learning.js writes 3 changesets for signature "anti-pattern-demo"
 *   2. learn-status.js evaluates pending changesets and reports 1 eligible signature
 *   3. learn-prepare.js pre-computes manifest, snapshots pre-image, and creates assimilation branch
 *   4. synthesis is simulated by appending new guardrail; validate-guardrail-regression.js and
 *      learn-apply.js --validate pass the strengthen-only regression check
 *   5. learn-apply.js --abort rolls back cleanly to the initial branch, restores .sdlc/config.json,
 *      and preserves untracked pending changesets
 *
 * Zero external dependencies. Zero mutations to the host repository.
 * Exit code: 0 on success, non-zero on failure.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const CAPTURE_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'util', 'capture-learning.js');
const STATUS_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'util', 'learn-status.js');
const PREPARE_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'skill', 'learn-prepare.js');
const REGRESSION_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'ci', 'validate-guardrail-regression.js');
const APPLY_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'skill', 'learn-apply.js');

function runGit(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${res.stderr || res.stdout}`);
  }
  return (res.stdout || '').trim();
}

function createHermeticRepo() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-loop-sim-'));
  const originDir = path.join(baseDir, 'origin.git');
  const workDir = path.join(baseDir, 'work');

  // 1. Bare remote origin
  runGit(baseDir, ['init', '--bare', '-q', '--initial-branch=main', originDir]);

  // 2. Working clone
  fs.mkdirSync(workDir);
  runGit(workDir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  runGit(workDir, ['config', 'user.email', 'sim@example.com']);
  runGit(workDir, ['config', 'user.name', 'Simulator']);
  runGit(workDir, ['config', 'commit.gpgsign', 'false']);
  runGit(workDir, ['checkout', '-q', '-b', 'main']);

  // 3. Baseline config
  const initialConfig = {
    version: { current: '1.0.0' },
    plan: {
      guardrails: [
        {
          id: 'baseline-rule',
          description: 'Baseline rule for simulation',
          severity: 'warning',
        },
      ],
    },
    execute: { guardrails: [] },
    rejected_guardrails: [],
    learn: {
      recurrenceThreshold: 3,
    },
  };

  fs.mkdirSync(path.join(workDir, '.sdlc'), { recursive: true });
  fs.writeFileSync(
    path.join(workDir, '.sdlc', 'config.json'),
    JSON.stringify(initialConfig, null, 2) + '\n'
  );
  fs.writeFileSync(path.join(workDir, 'README.md'), '# Simulation Fixture\n');

  runGit(workDir, ['add', '.']);
  runGit(workDir, ['commit', '-q', '-m', 'Initial baseline commit']);
  runGit(workDir, ['remote', 'add', 'origin', originDir]);
  runGit(workDir, ['push', '-q', 'origin', 'main']);
  runGit(workDir, ['fetch', '-q', 'origin', 'main']);

  return { baseDir, originDir, workDir, initialConfig };
}

function main() {
  console.log('[simulate-learning-loop] Setting up hermetic repository fixture...');
  const { baseDir, workDir, initialConfig } = createHermeticRepo();

  try {
    // -------------------------------------------------------------------------
    // Step 1: Ingestion via capture-learning.js
    // -------------------------------------------------------------------------
    console.log('[simulate-learning-loop] Step 1: Capturing 3 pending changesets for "anti-pattern-demo"...');
    for (let i = 1; i <= 3; i++) {
      const payload = {
        signature: 'anti-pattern-demo',
        rationale: `Detected unhandled timeout in task ${i}`,
        evidence: `Failure in worker gate execution step ${i}`,
        impact: 'medium',
        sourceSkill: 'execute-plan-sdlc',
        sourceRef: `task-${i}`,
      };
      const tmpFile = path.join(baseDir, `payload-${i}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(payload));

      const res = spawnSync(process.execPath, [CAPTURE_SCRIPT, '--file', tmpFile], {
        cwd: workDir,
        encoding: 'utf8',
      });
      fs.unlinkSync(tmpFile);
      assert.strictEqual(res.status, 0, `Capture ${i} failed: ${res.stderr}`);
    }

    const pendingDir = path.join(workDir, '.sdlc', 'learnings', 'pending');
    const capturedFiles = fs.readdirSync(pendingDir).filter((f) => !f.startsWith('.'));
    assert.strictEqual(capturedFiles.length, 3, `Expected 3 pending files, found ${capturedFiles.length}`);

    // -------------------------------------------------------------------------
    // Step 2: Status check via learn-status.js
    // -------------------------------------------------------------------------
    console.log('[simulate-learning-loop] Step 2: Checking learning status...');
    const statusRes = spawnSync(process.execPath, [STATUS_SCRIPT], {
      cwd: workDir,
      encoding: 'utf8',
    });
    assert.strictEqual(statusRes.status, 0, `Status check failed: ${statusRes.stderr}`);
    const status = JSON.parse(statusRes.stdout.trim());
    assert.strictEqual(status.eligibleCount, 1, `Expected eligibleCount 1, got ${status.eligibleCount}`);
    assert.strictEqual(status.waitingCount, 0, `Expected waitingCount 0, got ${status.waitingCount}`);
    assert.deepStrictEqual(status.eligibleSignatures, ['anti-pattern-demo']);

    // -------------------------------------------------------------------------
    // Step 3: Assimilation preparation via learn-prepare.js
    // -------------------------------------------------------------------------
    console.log('[simulate-learning-loop] Step 3: Preparing assimilation manifest...');
    const prepRes = spawnSync(process.execPath, [PREPARE_SCRIPT, '--output-file'], {
      cwd: workDir,
      encoding: 'utf8',
    });
    assert.strictEqual(prepRes.status, 0, `Prepare failed: ${prepRes.stderr}`);
    const manifestPath = prepRes.stdout.trim();
    assert.ok(fs.existsSync(manifestPath), `Manifest file not found: ${manifestPath}`);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(manifest.eligible.length, 1);
    assert.strictEqual(manifest.eligible[0].signature, 'anti-pattern-demo');
    assert.strictEqual(manifest.eligible[0].files.length, 3);
    assert.ok(manifest.branchName.startsWith('sdlc/assimilation-'));
    assert.strictEqual(manifest.initialBranch, 'main');

    const currentBranch = runGit(workDir, ['branch', '--show-current']);
    assert.strictEqual(currentBranch, manifest.branchName);

    // -------------------------------------------------------------------------
    // Step 4: Guardrail synthesis and regression validation
    // -------------------------------------------------------------------------
    console.log('[simulate-learning-loop] Step 4: Simulating synthesis and verifying regression gate...');
    const configPath = path.join(workDir, '.sdlc', 'config.json');
    const synthesizedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    synthesizedConfig.plan.guardrails.push({
      id: 'anti-pattern-demo',
      description: 'Ensure timeouts are configured in worker gates',
      severity: 'warning',
    });
    fs.writeFileSync(configPath, JSON.stringify(synthesizedConfig, null, 2) + '\n');

    // Regression check CLI
    const preFilePath = path.join(baseDir, 'pre-image.json');
    fs.writeFileSync(preFilePath, JSON.stringify(manifest.preImage, null, 2) + '\n');
    const regRes = spawnSync(process.execPath, [
      REGRESSION_SCRIPT,
      '--pre-file', preFilePath,
      '--post-file', configPath,
    ], {
      cwd: workDir,
      encoding: 'utf8',
    });
    assert.strictEqual(regRes.status, 0, `Regression validation failed: ${regRes.stderr || regRes.stdout}`);

    // learn-apply --validate
    const applyValRes = spawnSync(process.execPath, [
      APPLY_SCRIPT,
      '--validate',
      '--manifest', manifestPath,
    ], {
      cwd: workDir,
      encoding: 'utf8',
    });
    assert.strictEqual(applyValRes.status, 0, `learn-apply --validate failed: ${applyValRes.stderr}`);

    // -------------------------------------------------------------------------
    // Step 5: Abort and rollback verification
    // -------------------------------------------------------------------------
    console.log('[simulate-learning-loop] Step 5: Testing abort rollback...');
    const abortRes = spawnSync(process.execPath, [
      APPLY_SCRIPT,
      '--abort',
      '--manifest', manifestPath,
    ], {
      cwd: workDir,
      encoding: 'utf8',
    });
    assert.strictEqual(abortRes.status, 0, `learn-apply --abort failed: ${abortRes.stderr}`);

    // Verify branch restored to main
    const restoredBranch = runGit(workDir, ['branch', '--show-current']);
    assert.strictEqual(restoredBranch, 'main', `Expected branch main after abort, got ${restoredBranch}`);

    // Verify config restored to initial baseline
    const restoredConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(restoredConfig, initialConfig, 'Config was not properly restored after abort');

    // Verify pending files are preserved
    const preservedFiles = fs.readdirSync(pendingDir).filter((f) => !f.startsWith('.'));
    assert.strictEqual(preservedFiles.length, 3, 'Pending files must remain untouched after abort');

    // Clean up manifest file
    try { fs.unlinkSync(manifestPath); } catch (_) {}

    console.log('[simulate-learning-loop] ✅ All phases of the self-learning loop completed successfully.');
  } finally {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

if (require.main === module) {
  try {
    main();
    process.exit(0);
  } catch (err) {
    console.error(`[simulate-learning-loop] ❌ Failed: ${err.message}\n${err.stack}`);
    process.exit(2);
  }
}

module.exports = { main };
