'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'verify-tag-ancestry.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-tag-ancestry-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function run(cwd, args) {
  const result = spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('verify-tag-ancestry: missing --tag or --branch exits 1 with usage on stderr', () => {
  const dir = makeRepo();
  try {
    const result = run(dir, ['--tag', 'v1.0.0']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Usage: verify-tag-ancestry\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-tag-ancestry: unknown tag -> ok:false, exit 1', () => {
  const dir = makeRepo();
  try {
    const result = run(dir, ['--tag', 'v9.9.9', '--branch', 'main']);
    assert.strictEqual(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.ok, false);
    assert.match(output.message, /unknown tag/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-tag-ancestry: tag is an ancestor of local branch (no remote) -> ok:true, exit 0, uses fallback', () => {
  const dir = makeRepo();
  try {
    git(dir, ['tag', 'v1.0.0']);
    const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const result = run(dir, ['--tag', 'v1.0.0', '--branch', branch]);
    assert.strictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.branchRef, branch);
    assert.match(output.message, /fallback/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-tag-ancestry: tag is NOT an ancestor of a diverged branch -> ok:false, exit 1', () => {
  const dir = makeRepo();
  try {
    const mainBranch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    git(dir, ['checkout', '-q', '-b', 'other']);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'other commit']);
    git(dir, ['tag', 'v2.0.0']);
    git(dir, ['checkout', '-q', mainBranch]);

    const result = run(dir, ['--tag', 'v2.0.0', '--branch', mainBranch]);
    assert.strictEqual(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.ok, false);
    assert.match(output.message, /not an ancestor/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-tag-ancestry: unknown branch (no remote, no local ref) -> ok:false, exit 1', () => {
  const dir = makeRepo();
  try {
    git(dir, ['tag', 'v1.0.0']);
    const result = run(dir, ['--tag', 'v1.0.0', '--branch', 'does-not-exist']);
    assert.strictEqual(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.ok, false);
    assert.match(output.message, /unknown branch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
