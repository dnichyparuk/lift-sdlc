'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const {
  parseStateFilename,
  registerStatePrefix,
  getRegisteredPrefixes,
  pipelineAdvancing,
  initState,
} = require('./state');

// ---------------------------------------------------------------------------
// Prefix Registry & parseStateFilename Tests
// ---------------------------------------------------------------------------

test('parseStateFilename: parses canonical prefixes correctly', () => {
  const ship = parseStateFilename('ship-feat-auth-20260907T120000Z.json');
  assert.deepStrictEqual(ship, { prefix: 'ship', slug: 'feat-auth', timestamp: '20260907T120000Z' });

  const execute = parseStateFilename('execute-main-20260907T120001Z.json');
  assert.deepStrictEqual(execute, { prefix: 'execute', slug: 'main', timestamp: '20260907T120001Z' });

  const plan = parseStateFilename('plan-fix-issue-123-20260907T120002Z.json');
  assert.deepStrictEqual(plan, { prefix: 'plan', slug: 'fix-issue-123', timestamp: '20260907T120002Z' });

  const commit = parseStateFilename('commit-my-branch-20260907T120003Z.json');
  assert.deepStrictEqual(commit, { prefix: 'commit', slug: 'my-branch', timestamp: '20260907T120003Z' });
});

test('parseStateFilename: parses multi-hyphen prefix run-workflow without ambiguity', () => {
  const res = parseStateFilename('run-workflow-feat-complex-slug-20260907T143000Z.json');
  assert.deepStrictEqual(res, {
    prefix: 'run-workflow',
    slug: 'feat-complex-slug',
    timestamp: '20260907T143000Z',
  });
});

test('parseStateFilename: returns null for invalid filenames or unknown prefixes', () => {
  assert.strictEqual(parseStateFilename('random-file.json'), null);
  assert.strictEqual(parseStateFilename('unknown-branch-20260907T120000Z.json'), null);
  assert.strictEqual(parseStateFilename('ship-branch.json'), null);
  assert.strictEqual(parseStateFilename('ship-branch-invalidtimestamp.json'), null);
});

test('registerStatePrefix: registers new prefix with longest-first priority', () => {
  const initial = getRegisteredPrefixes();
  assert.ok(initial.includes('run-workflow'));
  assert.ok(initial.includes('ship'));

  registerStatePrefix('custom');
  registerStatePrefix('custom-pipeline');

  const after = getRegisteredPrefixes();
  assert.ok(after.includes('custom'));
  assert.ok(after.includes('custom-pipeline'));

  // 'custom-pipeline' must be matched before 'custom'
  const parsedLonger = parseStateFilename('custom-pipeline-my-slug-20260907T150000Z.json');
  assert.deepStrictEqual(parsedLonger, {
    prefix: 'custom-pipeline',
    slug: 'my-slug',
    timestamp: '20260907T150000Z',
  });

  const parsedShorter = parseStateFilename('custom-my-slug-20260907T150000Z.json');
  assert.deepStrictEqual(parsedShorter, {
    prefix: 'custom',
    slug: 'my-slug',
    timestamp: '20260907T150000Z',
  });
});

// ---------------------------------------------------------------------------
// pipelineAdvancing Helper Tests
// ---------------------------------------------------------------------------

test('pipelineAdvancing: returns advancing: false when state directory does not exist', () => {
  const prevOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  const nonExistent = path.join(os.tmpdir(), `nonexistent-sdlc-${Date.now()}`);
  process.env.SDLC_STATE_DIR_OVERRIDE = nonExistent;

  try {
    const res = pipelineAdvancing({ branch: 'test-branch' });
    assert.strictEqual(res.advancing, false);
    assert.strictEqual(res.prefix, null);
    assert.strictEqual(res.step, null);
  } finally {
    if (prevOverride !== undefined) {
      process.env.SDLC_STATE_DIR_OVERRIDE = prevOverride;
    } else {
      delete process.env.SDLC_STATE_DIR_OVERRIDE;
    }
  }
});

test('pipelineAdvancing: returns advancing: true and step info when a step is in_progress', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
  const prevOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  process.env.SDLC_STATE_DIR_OVERRIDE = tempDir;

  try {
    const branch = 'feature-test';
    const filePath = initState('ship', branch, {
      branch,
      flags: { auto: true },
      steps: [
        { name: 'execute', status: 'completed' },
        { name: 'review', status: 'in_progress' },
        { name: 'commit', status: 'pending' },
      ],
    });

    const res = pipelineAdvancing({ branch });
    assert.strictEqual(res.advancing, true);
    assert.strictEqual(res.prefix, 'ship');
    assert.strictEqual(res.step, 'review');
    assert.strictEqual(res.auto, true);
    assert.strictEqual(res.stateFile, filePath);
  } finally {
    if (prevOverride !== undefined) {
      process.env.SDLC_STATE_DIR_OVERRIDE = prevOverride;
    } else {
      delete process.env.SDLC_STATE_DIR_OVERRIDE;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('pipelineAdvancing: returns advancing: false when all steps are completed or pending', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
  const prevOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  process.env.SDLC_STATE_DIR_OVERRIDE = tempDir;

  try {
    const branch = 'feature-idle';
    initState('ship', branch, {
      branch,
      flags: { auto: false },
      steps: [
        { name: 'execute', status: 'completed' },
        { name: 'review', status: 'pending' },
      ],
    });

    const res = pipelineAdvancing({ branch });
    assert.strictEqual(res.advancing, false);
    assert.strictEqual(res.prefix, null);
    assert.strictEqual(res.step, null);
  } finally {
    if (prevOverride !== undefined) {
      process.env.SDLC_STATE_DIR_OVERRIDE = prevOverride;
    } else {
      delete process.env.SDLC_STATE_DIR_OVERRIDE;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('pipelineAdvancing: returns advancing: true and step: null when auto pipeline has pending steps', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
  const prevOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  process.env.SDLC_STATE_DIR_OVERRIDE = tempDir;

  try {
    const branch = 'feature-auto-pending';
    const filePath = initState('ship', branch, {
      branch,
      flags: { auto: true },
      steps: [
        { name: 'execute', status: 'completed' },
        { name: 'review', status: 'pending' },
      ],
    });

    const res = pipelineAdvancing({ branch });
    assert.strictEqual(res.advancing, true);
    assert.strictEqual(res.prefix, 'ship');
    assert.strictEqual(res.step, null);
    assert.strictEqual(res.auto, true);
    assert.strictEqual(res.stateFile, filePath);
  } finally {
    if (prevOverride !== undefined) {
      process.env.SDLC_STATE_DIR_OVERRIDE = prevOverride;
    } else {
      delete process.env.SDLC_STATE_DIR_OVERRIDE;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
