'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'run-workflow.js');
const { parseArgs, resolveManifest, injectResumeInfo } = require('./run-workflow');

test('parseArgs: extracts manifest and forwards other args', () => {
  const argv = ['node', 'run-workflow.js', '--manifest', 'skills/ship-sdlc/pipeline.json', '--output-file', '--dry-run', '--auto'];
  const res = parseArgs(argv);

  assert.strictEqual(res.manifestPath, 'skills/ship-sdlc/pipeline.json');
  assert.deepStrictEqual(res.forwarded, ['--output-file', '--dry-run', '--auto']);
});

test('parseArgs: handles trailing --manifest gracefully without forwarding', () => {
  const argv = ['node', 'run-workflow.js', '--dry-run', '--manifest'];
  const res = parseArgs(argv);

  assert.strictEqual(res.manifestPath, null);
  assert.deepStrictEqual(res.forwarded, ['--dry-run']);
});

test('resolveManifest: finds manifest relative to plugin root', () => {
  const resolved = resolveManifest('skills/ship-sdlc/pipeline.json');
  assert.ok(resolved);
  assert.ok(resolved.endsWith(path.join('skills', 'ship-sdlc', 'pipeline.json')));
});

test('run-workflow.js CLI: fails with exit code 1 when --manifest is missing', () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
  assert.ok(res.stderr.includes('--manifest <path> is required'));
});

test('run-workflow.js CLI: fails with exit code 1 when manifest file not found', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--manifest', 'non-existent-manifest.json'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
  assert.ok(res.stderr.includes('manifest file not found'));
});

test('run-workflow.js CLI: fails with exit code 1 when manifest is invalid JSON', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-test-'));
  const badJson = path.join(tempDir, 'bad.json');
  fs.writeFileSync(badJson, '{ not-valid-json', 'utf8');

  try {
    const res = spawnSync(process.execPath, [SCRIPT, '--manifest', badJson], { encoding: 'utf8' });
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('invalid manifest JSON'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('run-workflow.js CLI: fails with exit code 1 when manifest missing prepareScript', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-test-'));
  const noPrepare = path.join(tempDir, 'no-prepare.json');
  fs.writeFileSync(noPrepare, JSON.stringify({ name: 'test' }), 'utf8');

  try {
    const res = spawnSync(process.execPath, [SCRIPT, '--manifest', noPrepare], { encoding: 'utf8' });
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('manifest missing "prepareScript"'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('run-workflow.js CLI: happy path executes prepareScript and forwards arguments', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-happy-'));
  const mockScript = path.join(tempDir, 'mock-prepare.js');
  fs.writeFileSync(mockScript, `
    const args = process.argv.slice(2);
    process.stdout.write("MOCK_OUTPUT:" + args.join(',') + "\\n");
    process.exit(0);
  `, 'utf8');

  const manifestFile = path.join(tempDir, 'pipeline.json');
  fs.writeFileSync(manifestFile, JSON.stringify({
    pipeline: 'test-pipe',
    prepareScript: mockScript,
  }), 'utf8');

  try {
    const res = spawnSync(process.execPath, [SCRIPT, '--manifest', manifestFile, '--flag1', 'val1'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes('MOCK_OUTPUT:--flag1,val1'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// injectResumeInfo — generic --resume support (finding #8)
// ---------------------------------------------------------------------------

function withStateDirFixture(fn) {
  const fs = require('node:fs');
  const os = require('node:os');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-resume-state-'));
  const prevOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  process.env.SDLC_STATE_DIR_OVERRIDE = stateDir;
  try {
    return fn(stateDir);
  } finally {
    if (prevOverride === undefined) delete process.env.SDLC_STATE_DIR_OVERRIDE;
    else process.env.SDLC_STATE_DIR_OVERRIDE = prevOverride;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function writeManifestFixture(fs, os, data) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-resume-out-'));
  const outputFile = path.join(tempDir, 'manifest.json');
  fs.writeFileSync(outputFile, JSON.stringify(data), 'utf8');
  return { tempDir, outputFile };
}

test('injectResumeInfo: sets flags.resume + resume.found when --resume passed and state exists', () => {
  const fs = require('node:fs');
  const os = require('node:os');

  withStateDirFixture((stateDir) => {
    const branch = 'feature-test-resume';
    fs.writeFileSync(
      path.join(stateDir, `test-pipe-${branch}-20260101T000000000Z.json`),
      JSON.stringify({ steps: [{ name: 'execute', status: 'completed' }, { name: 'commit', status: 'pending' }] }),
      'utf8'
    );

    const { tempDir, outputFile } = writeManifestFixture(fs, os, {
      pipeline: 'test-pipe',
      context: { currentBranch: branch },
    });

    try {
      const injectedError = injectResumeInfo(outputFile, { pipeline: 'test-pipe', statePrefix: 'test-pipe' }, ['--resume']);
      assert.strictEqual(injectedError, false);

      const data = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      assert.strictEqual(data.flags.resume, true);
      assert.strictEqual(data.resume.found, true);
      assert.strictEqual(data.resume.nextPendingStep, 'commit');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test('injectResumeInfo: injects implicitResumeNoState error when --resume passed but no state exists', () => {
  const fs = require('node:fs');
  const os = require('node:os');

  withStateDirFixture(() => {
    const { tempDir, outputFile } = writeManifestFixture(fs, os, {
      pipeline: 'test-pipe',
      context: { currentBranch: 'feature-no-state' },
    });

    try {
      const injectedError = injectResumeInfo(outputFile, { pipeline: 'test-pipe', statePrefix: 'test-pipe' }, ['--resume']);
      assert.strictEqual(injectedError, true);

      const data = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      assert.strictEqual(data.flags.resume, false);
      assert.strictEqual(data.resume.found, false);
      assert.ok(data.errors.some(e => e.id === 'implicitResumeNoState'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test('injectResumeInfo: does not set flags.resume when --resume is not passed, even if state exists', () => {
  const fs = require('node:fs');
  const os = require('node:os');

  withStateDirFixture((stateDir) => {
    const branch = 'feature-no-flag';
    fs.writeFileSync(
      path.join(stateDir, `test-pipe-${branch}-20260101T000000000Z.json`),
      JSON.stringify({ steps: [{ name: 'execute', status: 'pending' }] }),
      'utf8'
    );

    const { tempDir, outputFile } = writeManifestFixture(fs, os, {
      pipeline: 'test-pipe',
      context: { currentBranch: branch },
    });

    try {
      const injectedError = injectResumeInfo(outputFile, { pipeline: 'test-pipe', statePrefix: 'test-pipe' }, []);
      assert.strictEqual(injectedError, false);

      const data = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      assert.strictEqual(data.flags, undefined);
      assert.strictEqual(data.resume, undefined);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test('injectResumeInfo: does not override a prepareScript that already sets flags.resume itself', () => {
  const fs = require('node:fs');
  const os = require('node:os');

  const { tempDir, outputFile } = writeManifestFixture(fs, os, {
    pipeline: 'ship-sdlc',
    flags: { resume: true, implicitResume: true },
  });

  try {
    const injectedError = injectResumeInfo(outputFile, { pipeline: 'ship-sdlc', statePrefix: 'ship' }, ['--resume']);
    assert.strictEqual(injectedError, false);

    const data = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    assert.strictEqual(data.resume, undefined); // untouched — ship.js owns this field itself
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

