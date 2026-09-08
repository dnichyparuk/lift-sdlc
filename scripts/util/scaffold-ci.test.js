'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const { MANIFEST, extractVersion, parseArgs } = require('./scaffold-ci');
const CLI = path.join(__dirname, 'scaffold-ci.js');

function run(args, env = {}, cwd = null) {
  const opts = {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  };
  if (cwd) opts.cwd = cwd;
  const res = spawnSync(process.execPath, [CLI, ...args], opts);
  let json = null;
  const stdout = (res.stdout || '').trim();
  if (stdout && fs.existsSync(stdout)) {
    try { json = JSON.parse(fs.readFileSync(stdout, 'utf8')); } catch (_) {
      // Ignore JSON parse errors in test helper
    }
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

test('parseArgs parses flags correctly', () => {
  assert.deepStrictEqual(parseArgs(['node', 'scaffold-ci.js']), {
    changelog: false,
    force: false,
    checkOnly: false,
  });

  assert.deepStrictEqual(parseArgs(['node', 'scaffold-ci.js', '--changelog', '--force', '--check-only']), {
    changelog: true,
    force: true,
    checkOnly: true,
  });
});

test('extractVersion parses version correctly', () => {
  const content1 = 'const RETAG_SCRIPT_VERSION = 42;';
  const regex1 = /const\s+RETAG_SCRIPT_VERSION\s*=\s*(\d+)/;
  assert.strictEqual(extractVersion(content1, regex1), 42);

  const content2 = 'unversioned content';
  assert.strictEqual(extractVersion(content2, regex1), 1);
});

test('MANIFEST entries have required properties', () => {
  assert.ok(Array.isArray(MANIFEST));
  assert.ok(MANIFEST.length >= 2);
  for (const entry of MANIFEST) {
    assert.ok(entry.src, 'entry missing src');
    assert.ok(entry.dest, 'entry missing dest');
    assert.ok(entry.versionRegex instanceof RegExp, 'entry missing versionRegex');
    assert.ok(entry.group, 'entry missing group');
  }
});

test('scaffold-ci CLI: --check-only reports file status', () => {
  const res = run(['--check-only']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.json, 'expected output manifest JSON');
  assert.ok(Array.isArray(res.json.files));
  assert.ok(res.json.files.length > 0);
  for (const file of res.json.files) {
    assert.ok(['missing', 'outdated', 'current'].includes(file.action));
  }
});

test('scaffold-ci CLI: includes changelog files when --changelog is specified', () => {
  const resNoChangelog = run(['--check-only']);
  const resChangelog = run(['--check-only', '--changelog']);

  assert.strictEqual(resNoChangelog.status, 0);
  assert.strictEqual(resChangelog.status, 0);
  assert.ok(resChangelog.json.files.length > resNoChangelog.json.files.length);
  assert.ok(resChangelog.json.files.some(f => f.group === 'changelog'));
});

test('scaffold-ci CLI: write mode creates files on clean project and skips when up to date', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-test-'));
  try {
    spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir });

    // 1. Initial creation
    const resCreate = run([], {}, tempDir);
    assert.strictEqual(resCreate.status, 0, resCreate.stderr);
    assert.ok(resCreate.json);
    assert.ok(resCreate.json.files.length > 0);
    for (const f of resCreate.json.files) {
      assert.strictEqual(f.action, 'created');
      assert.ok(fs.existsSync(path.join(tempDir, f.path)));
    }

    // 2. Skipped when run again
    const resSkip = run([], {}, tempDir);
    assert.strictEqual(resSkip.status, 0, resSkip.stderr);
    assert.ok(resSkip.json);
    for (const f of resSkip.json.files) {
      assert.strictEqual(f.action, 'skipped');
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('scaffold-ci CLI: warns on outdated files without overwriting, overwrites with --force', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-test-'));
  try {
    spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir });

    // Create initial files
    run([], {}, tempDir);

    // Simulate an outdated file
    const targetPath = path.join(tempDir, '.github', 'scripts', 'retag-release.cjs');
    fs.writeFileSync(targetPath, '// old version\nconst RETAG_SCRIPT_VERSION = 1;\n', 'utf8');

    // Run without --force: should report outdated and add warning
    const resOutdated = run([], {}, tempDir);
    assert.strictEqual(resOutdated.status, 0, resOutdated.stderr);
    const outdatedEntry = resOutdated.json.files.find(f => f.path === '.github/scripts/retag-release.cjs');
    assert.ok(outdatedEntry);
    assert.strictEqual(outdatedEntry.action, 'outdated');
    assert.ok(resOutdated.json.warnings.some(w => w.includes('Use --force to update')));
    // File content should not have been overwritten
    const contentUnchanged = fs.readFileSync(targetPath, 'utf8');
    assert.ok(contentUnchanged.includes('const RETAG_SCRIPT_VERSION = 1;'));

    // Run with --force: should overwrite
    const resForce = run(['--force'], {}, tempDir);
    assert.strictEqual(resForce.status, 0, resForce.stderr);
    const forceEntry = resForce.json.files.find(f => f.path === '.github/scripts/retag-release.cjs');
    assert.ok(forceEntry);
    assert.strictEqual(forceEntry.action, 'overwritten');
    const contentUpdated = fs.readFileSync(targetPath, 'utf8');
    assert.ok(!contentUpdated.includes('const RETAG_SCRIPT_VERSION = 1;'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
