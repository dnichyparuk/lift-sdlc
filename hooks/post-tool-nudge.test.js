'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, 'post-tool-nudge.js');
const { initState } = require('../scripts/lib/state');
const { exec } = require('../scripts/lib/git');

test('post-tool-nudge: outputs empty object when no state exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-test-'));
  try {
    const res = spawnSync(process.execPath, [HOOK_PATH], {
      input: '{}',
      encoding: 'utf8',
      env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: tempDir },
    });
    assert.strictEqual(res.status, 0);
    const json = JSON.parse(res.stdout.trim());
    assert.deepStrictEqual(json, {});
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('post-tool-nudge: outputs systemMessage when a step is in_progress', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-test-'));
  const prevOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  process.env.SDLC_STATE_DIR_OVERRIDE = tempDir;

  try {
    const branch = exec('git branch --show-current') || 'feature/test';

    initState('ship', branch, {
      branch,
      flags: { auto: true },
      steps: [{ name: 'commit', status: 'in_progress' }],
    });

    const res = spawnSync(process.execPath, [HOOK_PATH], {
      input: '{}',
      encoding: 'utf8',
      env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: tempDir, SDLC_BRANCH_OVERRIDE: branch },
    });
    assert.strictEqual(res.status, 0);
    const json = JSON.parse(res.stdout.trim());
    assert.ok(Array.isArray(json.injectSteps) && typeof json.injectSteps[0]?.systemMessage?.systemMessage === 'string');
    assert.ok(json.injectSteps[0].systemMessage.systemMessage.includes('commit'));
  } finally {
    if (prevOverride !== undefined) {
      process.env.SDLC_STATE_DIR_OVERRIDE = prevOverride;
    } else {
      delete process.env.SDLC_STATE_DIR_OVERRIDE;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('post-tool-nudge: resolves workspace from stdin.cwd when spawned outside workspace', () => {
  const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-cwd-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: tempWorkspace });
    const stateDir = path.join(tempWorkspace, '.sdlc', 'execution');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'ship-feature-cwd-nudge-20261125T100000Z.json'),
      JSON.stringify({
        branch: 'feature/cwd-nudge',
        flags: { auto: true },
        steps: [{ name: 'review', status: 'in_progress' }],
      }),
      'utf8'
    );

    const env = { ...process.env, SDLC_BRANCH_OVERRIDE: 'feature/cwd-nudge' };
    delete env.SDLC_STATE_DIR_OVERRIDE;

    const res = spawnSync(process.execPath, [HOOK_PATH], {
      cwd: os.tmpdir(),
      input: JSON.stringify({ cwd: tempWorkspace }),
      encoding: 'utf8',
      env,
    });
    assert.strictEqual(res.status, 0);
    const json = JSON.parse(res.stdout.trim());
    assert.ok(Array.isArray(json.injectSteps) && typeof json.injectSteps[0]?.systemMessage?.systemMessage === 'string');
    assert.ok(json.injectSteps[0].systemMessage.systemMessage.includes('review'));
  } finally {
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
  }
});
