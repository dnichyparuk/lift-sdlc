'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, 'stop-block.js');
const { initState } = require('../scripts/lib/state');
const { exec } = require('../scripts/lib/git');

test('stop-block: allows stop when no state file exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-block-test-'));
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

test('stop-block: blocks stop with continue when a step is in_progress', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-block-test-'));
  const prevOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  process.env.SDLC_STATE_DIR_OVERRIDE = tempDir;

  try {
    const branch = exec('git branch --show-current') || 'feature/test';

    initState('ship', branch, {
      branch,
      flags: { auto: false },
      steps: [
        { name: 'execute', status: 'completed' },
        { name: 'review', status: 'in_progress' },
      ],
    });

    const res = spawnSync(process.execPath, [HOOK_PATH], {
      encoding: 'utf8',
      env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: tempDir, SDLC_BRANCH_OVERRIDE: branch },
    });
    assert.strictEqual(res.status, 0);
    const json = JSON.parse(res.stdout.trim());
    assert.strictEqual(json.decision, 'continue');
    assert.ok(json.reason.includes('review'));
  } finally {
    if (prevOverride !== undefined) {
      process.env.SDLC_STATE_DIR_OVERRIDE = prevOverride;
    } else {
      delete process.env.SDLC_STATE_DIR_OVERRIDE;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('stop-block: blocks stop with continue between steps in auto mode', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-block-test-'));
  const prevOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  process.env.SDLC_STATE_DIR_OVERRIDE = tempDir;

  try {
    const branch = exec('git branch --show-current') || 'feature/test';

    initState('ship', branch, {
      branch,
      flags: { auto: true },
      steps: [
        { name: 'execute', status: 'completed' },
        { name: 'review', status: 'pending' },
      ],
    });

    const res = spawnSync(process.execPath, [HOOK_PATH], {
      encoding: 'utf8',
      env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: tempDir, SDLC_BRANCH_OVERRIDE: branch },
    });
    assert.strictEqual(res.status, 0);
    const json = JSON.parse(res.stdout.trim());
    assert.strictEqual(json.decision, 'continue');
    assert.ok(json.reason.includes('auto mode'));
  } finally {
    if (prevOverride !== undefined) {
      process.env.SDLC_STATE_DIR_OVERRIDE = prevOverride;
    } else {
      delete process.env.SDLC_STATE_DIR_OVERRIDE;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

