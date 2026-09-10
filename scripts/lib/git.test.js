'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { exec, fetchPrChecks, probeGhAuth, createBranch, checkoutBranch } = require('./git.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-lib-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

test('exec() does not silently truncate output larger than execSync\'s 1 MiB default maxBuffer', () => {
  // Reproduces the review-sdlc/pr-sdlc "0-byte diff" bug: a large `git diff`
  // output exceeded execSync's default 1 MiB maxBuffer, which threw
  // ERR_CHILD_PROCESS_STDOUT_MAXBUFFER — silently caught by exec() and
  // returned as null, misread downstream as "no diff content" for every file.
  const oneMiB = 1024 * 1024;
  const targetBytes = oneMiB + 100 * 1024; // safely over the 1 MiB default
  // Print `targetBytes` 'a' characters via Node itself — avoids depending on
  // a platform-specific shell builtin (yes/head) being present.
  const cmd = `node -e "process.stdout.write('a'.repeat(${targetBytes}))"`;

  const result = exec(cmd);

  assert.notStrictEqual(result, null, 'exec() must not return null for output over the old 1 MiB default');
  assert.ok(result.length >= targetBytes - 1, `expected >= ${targetBytes - 1} chars, got ${result.length}`);
});

test('exec() still returns null on a genuinely failing command', () => {
  const result = exec('node -e "process.exit(1)"');
  assert.strictEqual(result, null);
});

test('exec() rethrows on a genuinely failing command when throwOnError is set', () => {
  assert.throws(() => exec('node -e "process.exit(1)"', { throwOnError: true }));
});

test('fetchPrChecks() returns structured object distinguishing auth-failure from empty-checks', () => {
  // When prNumber is undefined/null, return empty checks with authenticated=true, errorMessage=null
  const result1 = fetchPrChecks(null);
  assert.ok(result1 && typeof result1 === 'object', 'fetchPrChecks(null) returns an object');
  assert.ok(Array.isArray(result1.checks), 'result has checks array');
  assert.strictEqual(result1.checks.length, 0, 'checks is empty');
  assert.strictEqual(result1.ghAuthenticated, true, 'ghAuthenticated is true for null prNumber');
  assert.strictEqual(result1.errorMessage, null, 'errorMessage is null for null prNumber');

  const result2 = fetchPrChecks(undefined);
  assert.ok(result2 && typeof result2 === 'object', 'fetchPrChecks(undefined) returns an object');
  assert.ok(Array.isArray(result2.checks), 'result has checks array');
  assert.strictEqual(result2.checks.length, 0, 'checks is empty');
  assert.strictEqual(result2.ghAuthenticated, true, 'ghAuthenticated is true for undefined prNumber');
  assert.strictEqual(result2.errorMessage, null, 'errorMessage is null for undefined prNumber');
});

// ---------------------------------------------------------------------------
// createBranch — integration style, real exec against a temp repo
// ---------------------------------------------------------------------------

function makeRepoWithRemote() {
  const dir = makeRepo();
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-lib-remote-'));
  git(remoteDir, ['init', '-q', '--bare']);
  git(dir, ['remote', 'add', 'origin', remoteDir]);
  git(dir, ['push', '-q', 'origin', 'main']);
  git(dir, ['fetch', '-q', 'origin']);
  return { dir, remoteDir };
}

test('createBranch creates a branch from an explicit start point and checks it out', () => {
  const dir = makeRepo();
  try {
    const result = createBranch(dir, 'feature-x', 'main');
    assert.strictEqual(result, 'created');
    assert.strictEqual(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature-x');
    assert.strictEqual(git(dir, ['rev-parse', 'feature-x']).trim(), git(dir, ['rev-parse', 'main']).trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createBranch passes --no-track so the new branch gets NO upstream (R8 fix)', () => {
  const { dir, remoteDir } = makeRepoWithRemote();
  try {
    const result = createBranch(dir, 'feature-y', 'origin/main');
    assert.strictEqual(result, 'created');
    assert.strictEqual(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature-y');
    // branch.<name>.merge/.remote are only set when a branch tracks an upstream;
    // `git config` exits non-zero (throws with execFileSync) when the key is unset.
    assert.throws(() => git(dir, ['config', 'branch.feature-y.merge']), /Command failed/);
    assert.throws(() => git(dir, ['config', 'branch.feature-y.remote']), /Command failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test('createBranch refuses a branch name that already exists, never moves it, returns error', () => {
  const dir = makeRepo();
  try {
    git(dir, ['branch', 'dup']);
    const dupCommitBefore = git(dir, ['rev-parse', 'dup']).trim();
    const startingBranch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

    // Advance main so 'dup' (still at the old commit) diverges from it.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'advanced');
    git(dir, ['commit', '-a', '-q', '-m', 'advance main']);

    const result = createBranch(dir, 'dup', 'main');
    assert.strictEqual(result, 'error');
    // 'dup' was not moved to the new start point.
    assert.strictEqual(git(dir, ['rev-parse', 'dup']).trim(), dupCommitBefore);
    // The current branch was not switched.
    assert.strictEqual(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), startingBranch);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createBranch returns error (never throws) when the start point does not exist', () => {
  const dir = makeRepo();
  try {
    const result = createBranch(dir, 'feature-z', 'does-not-exist-start-point');
    assert.strictEqual(result, 'error');
    assert.throws(() => git(dir, ['rev-parse', '--verify', 'refs/heads/feature-z']));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// checkoutBranch — integration style, real exec against a temp repo
// ---------------------------------------------------------------------------

test('checkoutBranch checks out an existing branch by name, returns checked-out', () => {
  const dir = makeRepo();
  try {
    git(dir, ['branch', 'other']);
    const result = checkoutBranch(dir, 'other');
    assert.strictEqual(result, 'checked-out');
    assert.strictEqual(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'other');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkoutBranch returns error (never throws) for a branch that does not exist', () => {
  const dir = makeRepo();
  try {
    const result = checkoutBranch(dir, 'does-not-exist');
    assert.strictEqual(result, 'error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkoutBranch returns dirty and does not switch when a tracked file has uncommitted changes', () => {
  const dir = makeRepo();
  try {
    git(dir, ['branch', 'other']);
    const startingBranch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty change'); // tracked file, uncommitted

    const result = checkoutBranch(dir, 'other');
    assert.strictEqual(result, 'dirty');
    assert.strictEqual(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), startingBranch);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkoutBranch ignores untracked files (not dirty) and checks out normally', () => {
  const dir = makeRepo();
  try {
    git(dir, ['branch', 'other']);
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'not tracked');

    const result = checkoutBranch(dir, 'other');
    assert.strictEqual(result, 'checked-out');
    assert.strictEqual(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'other');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
