'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, 'stop-state-save.js');
const { initState, slugifyBranch } = require('../scripts/lib/state');
const { exec } = require('../scripts/lib/git');

test('stop-state-save: exits 0 with decision: allow when no pipeline state exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-test-'));
  try {
    const res = spawnSync(process.execPath, [HOOK_PATH], {
      encoding: 'utf8',
      env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: tempDir },
    });
    assert.strictEqual(res.status, 0);
    const json = JSON.parse(res.stdout.trim());
    assert.strictEqual(json.decision, 'allow');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('stop-state-save: saves compact recovery for active custom pipeline', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-test-'));
  try {
    const branch = exec('git branch --show-current');
    if (!branch) return; // Skip if no current branch in test env

    const branchSlug = slugifyBranch(branch);
    initState('run-workflow', branch, {
      pipeline: 'run-workflow',
      branch,
      flags: { auto: true },
      steps: [
        { name: 'execute', status: 'in_progress' },
      ],
    });

    // Move or verify inside tempDir
    const res = spawnSync(process.execPath, [HOOK_PATH], {
      encoding: 'utf8',
      env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: tempDir },
    });
    assert.strictEqual(res.status, 0);
    const json = JSON.parse(res.stdout.trim());
    assert.strictEqual(json.decision, 'allow');

    const recoveryFile = path.join(tempDir, `.compact-recovery-${branchSlug}.json`);
    if (fs.existsSync(recoveryFile)) {
      const rec = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'));
      assert.strictEqual(rec.pipeline, 'run-workflow');
      assert.strictEqual(rec.currentStep, 'execute');
      assert.strictEqual(rec.flags.auto, true);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
