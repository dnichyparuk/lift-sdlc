'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, 'question-suppression.js');
const { initState } = require('../scripts/lib/state');
const { exec } = require('../scripts/lib/git');

test('question-suppression: allows AskUserQuestion when no state file exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-supp-test-'));
  try {
    const payload = JSON.stringify({
      toolCall: {
        name: 'AskUserQuestion',
        args: { questions: [{ question: 'Pick an option', options: ['A', 'B'] }] },
      },
    });

    const res = spawnSync(process.execPath, [HOOK_PATH], {
      input: payload,
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

test('question-suppression: allows AskUserQuestion in interactive mode (auto=false)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-supp-test-'));
  const prevOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  process.env.SDLC_STATE_DIR_OVERRIDE = tempDir;

  try {
    const branch = exec('git branch --show-current') || 'feature/test';

    initState('ship', branch, {
      branch,
      flags: { auto: false },
      steps: [{ name: 'execute', status: 'in_progress' }],
    });

    const payload = JSON.stringify({
      toolCall: {
        name: 'AskUserQuestion',
        args: { questions: [{ question: 'Which library?', options: ['A', 'B'] }] },
      },
    });

    const res = spawnSync(process.execPath, [HOOK_PATH], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: tempDir, SDLC_BRANCH_OVERRIDE: branch },
    });
    assert.strictEqual(res.status, 0);
    const json = JSON.parse(res.stdout.trim());
    assert.strictEqual(json.decision, 'allow');
  } finally {
    if (prevOverride !== undefined) {
      process.env.SDLC_STATE_DIR_OVERRIDE = prevOverride;
    } else {
      delete process.env.SDLC_STATE_DIR_OVERRIDE;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('question-suppression: denies non-approval questions in auto mode with corrective guidance', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-supp-test-'));
  const prevOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  process.env.SDLC_STATE_DIR_OVERRIDE = tempDir;

  try {
    const branch = exec('git branch --show-current') || 'feature/test';

    initState('ship', branch, {
      branch,
      flags: { auto: true },
      steps: [{ name: 'review', status: 'in_progress' }],
    });

    const payload = JSON.stringify({
      toolCall: {
        name: 'AskUserQuestion',
        args: { questions: [{ question: 'Which style?', options: ['Style1', 'Style2'] }] },
      },
    });

    const res = spawnSync(process.execPath, [HOOK_PATH], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: tempDir, SDLC_BRANCH_OVERRIDE: branch },
    });
    assert.strictEqual(res.status, 0);
    const json = JSON.parse(res.stdout.trim());
    assert.strictEqual(json.decision, 'deny');
    assert.ok(json.reason.includes('review'));
    assert.ok(json.reason.includes('record-assumption.js'));
  } finally {
    if (prevOverride !== undefined) {
      process.env.SDLC_STATE_DIR_OVERRIDE = prevOverride;
    } else {
      delete process.env.SDLC_STATE_DIR_OVERRIDE;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('question-suppression: allows questions containing approval gate markers even in auto mode', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-supp-test-'));
  const prevOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  process.env.SDLC_STATE_DIR_OVERRIDE = tempDir;

  try {
    const branch = exec('git branch --show-current') || 'feature/test';

    initState('ship', branch, {
      branch,
      flags: { auto: true },
      steps: [{ name: 'version', status: 'in_progress' }],
    });

    const payload = JSON.stringify({
      toolCall: {
        name: 'AskUserQuestion',
        args: { questions: [{ question: 'Do you approve and wish to proceed with the release?', options: ['Yes', 'No'] }] },
      },
    });

    const res = spawnSync(process.execPath, [HOOK_PATH], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: tempDir, SDLC_BRANCH_OVERRIDE: branch },
    });
    assert.strictEqual(res.status, 0);
    const json = JSON.parse(res.stdout.trim());
    assert.strictEqual(json.decision, 'allow');
  } finally {
    if (prevOverride !== undefined) {
      process.env.SDLC_STATE_DIR_OVERRIDE = prevOverride;
    } else {
      delete process.env.SDLC_STATE_DIR_OVERRIDE;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('question-suppression: denies non-approval ask_question in auto mode', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-supp-test-'));
  const prevOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  process.env.SDLC_STATE_DIR_OVERRIDE = tempDir;

  try {
    const branch = exec('git branch --show-current') || 'feature/test';

    initState('ship', branch, {
      branch,
      flags: { auto: true },
      steps: [{ name: 'review', status: 'in_progress' }],
    });

    const payload = JSON.stringify({
      toolCall: {
        name: 'ask_question',
        args: { questions: [{ question: 'Which style?', options: ['Style1', 'Style2'] }] },
      },
    });

    const res = spawnSync(process.execPath, [HOOK_PATH], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: tempDir, SDLC_BRANCH_OVERRIDE: branch },
    });
    assert.strictEqual(res.status, 0);
    const json = JSON.parse(res.stdout.trim());
    assert.strictEqual(json.decision, 'deny');
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

test('question-suppression: allows ask_question with approval marker in auto mode', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-supp-test-'));
  const prevOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  process.env.SDLC_STATE_DIR_OVERRIDE = tempDir;

  try {
    const branch = exec('git branch --show-current') || 'feature/test';

    initState('ship', branch, {
      branch,
      flags: { auto: true },
      steps: [{ name: 'version', status: 'in_progress' }],
    });

    const payload = JSON.stringify({
      toolCall: {
        name: 'ask_question',
        args: { questions: [{ question: 'Do you approve and wish to proceed with the release?', options: ['Yes', 'No'] }] },
      },
    });

    const res = spawnSync(process.execPath, [HOOK_PATH], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: tempDir, SDLC_BRANCH_OVERRIDE: branch },
    });
    assert.strictEqual(res.status, 0);
    const json = JSON.parse(res.stdout.trim());
    assert.strictEqual(json.decision, 'allow');
  } finally {
    if (prevOverride !== undefined) {
      process.env.SDLC_STATE_DIR_OVERRIDE = prevOverride;
    } else {
      delete process.env.SDLC_STATE_DIR_OVERRIDE;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('question-suppression: fails closed (deny) on malformed or unparseable stdin', () => {
  const res = spawnSync(process.execPath, [HOOK_PATH], {
    input: '{ not-json',
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 0);
  const json = JSON.parse(res.stdout.trim());
  assert.strictEqual(json.decision, 'deny');
  assert.ok(json.reason.includes('fail-closed'));
});

