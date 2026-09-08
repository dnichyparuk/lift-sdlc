'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { parseArgs, runStash, dropStash, revertFile } = require('./rollback-stash');

const SCRIPT = path.join(__dirname, 'rollback-stash.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-stash-'));
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

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs reads the stash command with no flags', () => {
  const parsed = parseArgs(['node', 'rollback-stash.js', 'stash']);
  assert.strictEqual(parsed.command, 'stash');
  assert.strictEqual(parsed.drop, null);
  assert.strictEqual(parsed.label, null);
  assert.strictEqual(parsed.path, null);
});

test('parseArgs reads stash --drop <ref>', () => {
  const parsed = parseArgs(['node', 'rollback-stash.js', 'stash', '--drop', 'stash@{0}']);
  assert.strictEqual(parsed.command, 'stash');
  assert.strictEqual(parsed.drop, 'stash@{0}');
});

test('parseArgs reads revert-file --path <file>', () => {
  const parsed = parseArgs(['node', 'rollback-stash.js', 'revert-file', '--path', 'scripts/foo.js']);
  assert.strictEqual(parsed.command, 'revert-file');
  assert.strictEqual(parsed.path, 'scripts/foo.js');
});

test('parseArgs reads stash --label <text>', () => {
  const parsed = parseArgs(['node', 'rollback-stash.js', 'stash', '--label', 'failed-wave-3']);
  assert.strictEqual(parsed.label, 'failed-wave-3');
});

// ---------------------------------------------------------------------------
// runStash — injectable spawnFn, no real git repo required
// ---------------------------------------------------------------------------

test('runStash returns nothing_to_stash when git stash push reports no local changes', () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push(args);
    return { status: 0, stdout: 'No local changes to save\n', stderr: '' };
  };
  const result = runStash({ spawnFn });
  assert.deepStrictEqual(result, { status: 'nothing_to_stash' });
  // Only the push was attempted — no confirmation calls needed.
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].slice(0, 2), ['stash', 'push']);
});

test('runStash returns failed when git stash push itself fails', () => {
  const spawnFn = () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' });
  const result = runStash({ spawnFn });
  assert.strictEqual(result.status, 'failed');
  assert.match(result.message, /not a git repository/);
});

test('runStash returns stashed with the ref parsed from git stash list on success', () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push(args);
    if (args[0] === 'stash' && args[1] === 'push') {
      return { status: 0, stdout: 'Saved working directory and index state On main: rollback-...\n', stderr: '' };
    }
    if (args[0] === 'status') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'stash' && args[1] === 'list') {
      return { status: 0, stdout: 'stash@{0}: On main: rollback-2026-09-02T00:00:00.000Z\n', stderr: '' };
    }
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const result = runStash({ spawnFn, label: 'rollback' });
  assert.deepStrictEqual(result, { status: 'stashed', ref: 'stash@{0}' });
  assert.strictEqual(calls.length, 3);
});

test('runStash uses the given label in the timestamped stash message', () => {
  let pushMessage = null;
  const spawnFn = (cmd, args) => {
    if (args[0] === 'stash' && args[1] === 'push') {
      pushMessage = args[3];
      return { status: 0, stdout: 'Saved working directory and index state\n', stderr: '' };
    }
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'stash' && args[1] === 'list') {
      return { status: 0, stdout: 'stash@{0}: On main: failed-wave-3-...\n', stderr: '' };
    }
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  runStash({ spawnFn, label: 'failed-wave-3' });
  assert.match(pushMessage, /^failed-wave-3-\d{4}-\d{2}-\d{2}T/);
});

test('runStash returns failed when git stash list has no matching entry after a successful push', () => {
  const spawnFn = (cmd, args) => {
    if (args[0] === 'stash' && args[1] === 'push') {
      return { status: 0, stdout: 'Saved working directory and index state\n', stderr: '' };
    }
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'stash' && args[1] === 'list') {
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const result = runStash({ spawnFn });
  assert.strictEqual(result.status, 'failed');
  assert.match(result.message, /no matching entry/);
});

// ---------------------------------------------------------------------------
// dropStash — injectable spawnFn
// ---------------------------------------------------------------------------

test('dropStash returns dropped on success and passes the ref through to git stash drop', () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push(args);
    return { status: 0, stdout: 'Dropped stash@{0}\n', stderr: '' };
  };
  const result = dropStash('stash@{0}', { spawnFn });
  assert.deepStrictEqual(result, { status: 'dropped', ref: 'stash@{0}' });
  assert.deepStrictEqual(calls[0], ['stash', 'drop', 'stash@{0}']);
});

test('dropStash returns failed with the ref echoed back when git stash drop fails', () => {
  const spawnFn = () => ({ status: 1, stdout: '', stderr: "error: stash@{5} is not a valid reference" });
  const result = dropStash('stash@{5}', { spawnFn });
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.ref, 'stash@{5}');
  assert.match(result.message, /not a valid reference/);
});

// ---------------------------------------------------------------------------
// revertFile — injectable spawnFn
// ---------------------------------------------------------------------------

test('revertFile returns reverted on success', () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = revertFile('scripts/foo.js', { spawnFn });
  assert.deepStrictEqual(result, { status: 'reverted', path: 'scripts/foo.js' });
  assert.deepStrictEqual(calls[0], ['checkout', '--', 'scripts/foo.js']);
});

test('revertFile returns failed with the path echoed back when git checkout fails', () => {
  const spawnFn = () => ({ status: 1, stdout: '', stderr: "error: pathspec 'nope.js' did not match any file(s)" });
  const result = revertFile('nope.js', { spawnFn });
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.path, 'nope.js');
  assert.match(result.message, /did not match any file/);
});

// ---------------------------------------------------------------------------
// End-to-end CLI against a real repo
// ---------------------------------------------------------------------------

test('CLI stash: clean tree -> nothing_to_stash, exit 0', () => {
  const dir = makeRepo();
  try {
    const result = run(dir, ['stash']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), { status: 'nothing_to_stash' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI stash: dirty tree -> stashed with a ref, then stash --drop <ref> -> dropped', () => {
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');

    const stashResult = run(dir, ['stash']);
    assert.strictEqual(stashResult.status, 0, stashResult.stderr);
    const stashed = JSON.parse(stashResult.stdout);
    assert.strictEqual(stashed.status, 'stashed');
    assert.match(stashed.ref, /^stash@\{\d+\}$/);

    // Working tree is clean again after the stash.
    const statusAfterStash = git(dir, ['status', '--porcelain']);
    assert.strictEqual(statusAfterStash.trim(), '');

    const dropResult = run(dir, ['stash', '--drop', stashed.ref]);
    assert.strictEqual(dropResult.status, 0, dropResult.stderr);
    assert.deepStrictEqual(JSON.parse(dropResult.stdout), { status: 'dropped', ref: stashed.ref });

    const stashList = git(dir, ['stash', 'list']);
    assert.strictEqual(stashList.trim(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI revert-file: reverts a modified tracked file back to HEAD', () => {
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'modified');
    const result = run(dir, ['revert-file', '--path', 'a.txt']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), { status: 'reverted', path: 'a.txt' });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI with no recognized command prints usage and exits 1', () => {
  const dir = makeRepo();
  try {
    const result = run(dir, []);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Usage:\n {2}rollback-stash\.js stash/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI revert-file without --path prints usage and exits 1', () => {
  const dir = makeRepo();
  try {
    const result = run(dir, ['revert-file']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Usage:\n {2}rollback-stash\.js stash/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
