'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { parseArgs, runWorkspaceSetup } = require('./ship-workspace-setup');

const SCRIPT = path.join(__dirname, 'ship-workspace-setup.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ship-ws-setup-'));
}

function makeTempRepo() {
  const dir = makeTempDir();
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function run(args, cwd) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: path.join(cwd, '.sdlc-test-state') },
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch (_) { /* left null */ }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

/**
 * Run `runWorkspaceSetup` in-process against a temp repo, with a stubbed
 * `runGitFn` so the branch-checkout git calls never touch the real `git`
 * binary. Restores cwd/env afterwards.
 */
function runInProcess(args, cwd, runGitFn) {
  const originalCwd = process.cwd();
  const originalOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  process.chdir(cwd);
  process.env.SDLC_STATE_DIR_OVERRIDE = path.join(cwd, '.sdlc-test-state');
  try {
    return runWorkspaceSetup(['node', 'ship-workspace-setup.js', ...args], { runGitFn });
  } finally {
    process.chdir(originalCwd);
    if (originalOverride === undefined) delete process.env.SDLC_STATE_DIR_OVERRIDE;
    else process.env.SDLC_STATE_DIR_OVERRIDE = originalOverride;
  }
}

function makeGitStub(results) {
  let call = 0;
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    const result = results[call] !== undefined ? results[call] : { ok: true, stderr: '' };
    call++;
    return result;
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs reads all four workspace flags', () => {
  const parsed = parseArgs([
    'node', 'ship-workspace-setup.js',
    '--workspace-flag', 'worktree',
    '--prepare-output-file', '/tmp/prepare.json',
    '--logical-type', 'bugfix',
    '--derived-slug', 'fix-the-thing',
  ]);

  assert.deepStrictEqual(parsed, {
    workspaceFlag:     'worktree',
    prepareOutputFile: '/tmp/prepare.json',
    logicalType:       'bugfix',
    derivedSlug:       'fix-the-thing',
    unknown:           null,
  });
});

test('parseArgs defaults every flag to an empty string', () => {
  const parsed = parseArgs(['node', 'ship-workspace-setup.js']);
  assert.strictEqual(parsed.workspaceFlag, '');
  assert.strictEqual(parsed.prepareOutputFile, '');
  assert.strictEqual(parsed.logicalType, '');
  assert.strictEqual(parsed.derivedSlug, '');
  assert.strictEqual(parsed.unknown, null);
});

test('parseArgs reports the first unknown parameter', () => {
  const parsed = parseArgs(['node', 'ship-workspace-setup.js', '--bogus', 'x']);
  assert.strictEqual(parsed.unknown, '--bogus');
});

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

test('--help prints usage to stdout and exits 0, bypassing the JSON protocol', () => {
  const dir = makeTempDir();
  try {
    const res = run(['--help'], dir);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(res.stderr, '');
    assert.match(res.stdout, /^Usage: node ship-workspace-setup\.js/);
    assert.match(res.stdout, /--workspace-flag/);
    assert.match(res.stdout, /--prepare-output-file/);
    assert.match(res.stdout, /--logical-type/);
    assert.match(res.stdout, /--derived-slug/);
    assert.match(res.stdout, /--help, -h/);
    // Not JSON — the --help path bypasses the JSON output protocol entirely.
    assert.strictEqual(res.json, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('-h behaves the same as --help', () => {
  const dir = makeTempDir();
  try {
    const res = run(['-h'], dir);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /^Usage: node ship-workspace-setup\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

test('branch mode creates the resolved branch and reports success', () => {
  const repo = makeTempRepo();
  try {
    const res = run(
      ['--workspace-flag', 'branch', '--logical-type', 'feature', '--derived-slug', 'my-thing'],
      repo
    );

    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(res.json, `expected JSON on stdout, got: ${res.stdout}`);
    assert.strictEqual(res.json.status, 'success');
    assert.strictEqual(res.json.workspaceMode, 'branch');
    assert.strictEqual(res.json.executeBranch, 'feat/my-thing');
    assert.strictEqual(res.json.worktreePath, '');

    const current = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.strictEqual(current, 'feat/my-thing');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('branch mode: first checkout succeeds -> success (injected runGitFn)', () => {
  const repo = makeTempRepo();
  try {
    const gitStub = makeGitStub([{ ok: true, stderr: '' }]);
    const result = runInProcess(
      ['--workspace-flag', 'branch', '--logical-type', 'feature', '--derived-slug', 'my-thing'],
      repo,
      gitStub
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.json.status, 'success');
    assert.strictEqual(result.json.executeBranch, 'feat/my-thing');
    assert.strictEqual(gitStub.calls.length, 1);
    assert.deepStrictEqual(gitStub.calls[0], ['checkout', 'feat/my-thing']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('branch mode: first checkout fails, -b succeeds -> success (injected runGitFn)', () => {
  const repo = makeTempRepo();
  try {
    const gitStub = makeGitStub([
      { ok: false, stderr: 'error: pathspec did not match' },
      { ok: true, stderr: '' },
    ]);
    const result = runInProcess(
      ['--workspace-flag', 'branch', '--logical-type', 'feature', '--derived-slug', 'my-thing'],
      repo,
      gitStub
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.json.status, 'success');
    assert.strictEqual(result.json.executeBranch, 'feat/my-thing');
    assert.strictEqual(gitStub.calls.length, 2);
    assert.deepStrictEqual(gitStub.calls[0], ['checkout', 'feat/my-thing']);
    assert.deepStrictEqual(gitStub.calls[1], ['checkout', '-b', 'feat/my-thing']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('branch mode: both checkout attempts fail -> error status, exit 2', () => {
  const repo = makeTempRepo();
  try {
    const gitStub = makeGitStub([
      { ok: false, stderr: 'error: pathspec did not match any file(s)' },
      { ok: false, stderr: "fatal: a branch named 'feat/my-thing' already exists" },
    ]);
    const result = runInProcess(
      ['--workspace-flag', 'branch', '--logical-type', 'feature', '--derived-slug', 'my-thing'],
      repo,
      gitStub
    );

    assert.strictEqual(result.exitCode, 2);
    assert.strictEqual(result.json.status, 'error');
    assert.match(result.json.error, /feat\/my-thing/);
    assert.match(result.json.error, /a branch named 'feat\/my-thing' already exists/);
    assert.strictEqual(gitStub.calls.length, 2);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('both checkout attempts fail, -b produced no stderr -> falls back to the first checkout\'s stderr', () => {
  const repo = makeTempRepo();
  try {
    const gitStub = makeGitStub([
      { ok: false, stderr: 'error: pathspec did not match any file(s) known to git' },
      { ok: false, stderr: '' },
    ]);
    const result = runInProcess(
      ['--workspace-flag', 'branch', '--logical-type', 'feature', '--derived-slug', 'my-thing'],
      repo,
      gitStub
    );

    assert.strictEqual(result.exitCode, 2);
    assert.strictEqual(result.json.status, 'error');
    assert.match(result.json.error, /feat\/my-thing/);
    assert.match(result.json.error, /pathspec did not match any file\(s\) known to git/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

test('missing workspace mode exits 1 with an error payload', () => {
  const dir = makeTempDir();
  try {
    const res = run([], dir);

    assert.strictEqual(res.status, 1);
    assert.ok(res.json, `expected JSON on stdout, got: ${res.stdout}`);
    assert.strictEqual(res.json.status, 'error');
    assert.match(res.json.error, /Workspace mode not set/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cwd assertion failure exits 1 with the expected root in the message', () => {
  const repo = makeTempRepo();
  try {
    const manifest = path.join(repo, 'prepare.json');
    fs.writeFileSync(manifest, JSON.stringify({
      assertions: {
        requireMainWorktreeCwd: true,
        expectedMainWorktreeRoot: '/definitely/not/this/repo',
      },
    }));

    const res = run(
      ['--workspace-flag', 'branch', '--prepare-output-file', manifest, '--derived-slug', 'my-thing'],
      repo
    );

    assert.strictEqual(res.status, 1);
    assert.ok(res.json, `expected JSON on stdout, got: ${res.stdout}`);
    assert.strictEqual(res.json.status, 'error');
    assert.match(res.json.error, /cwd assertion failed/);
    assert.match(res.json.error, /\/definitely\/not\/this\/repo/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('unknown parameter exits 1 with a stderr diagnostic and no stdout JSON', () => {
  const dir = makeTempDir();
  try {
    const res = run(['--nope'], dir);

    assert.strictEqual(res.status, 1);
    assert.strictEqual(res.stdout, '');
    assert.match(res.stderr, /Unknown parameter passed: --nope/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing lib produces parseable JSON + exit 2 instead of a raw stack trace', () => {
  // Copies the script + its lib/ sibling into an isolated temp tree, then
  // deletes the copy's config.js — never the real scripts/lib/config.js,
  // which other test files running concurrently under `node --test` also
  // depend on.
  const isolatedRoot = makeTempDir();
  const repo = makeTempRepo();
  try {
    const isolatedUtil = path.join(isolatedRoot, 'scripts', 'util');
    const isolatedLib  = path.join(isolatedRoot, 'scripts', 'lib');
    fs.mkdirSync(isolatedUtil, { recursive: true });
    fs.cpSync(path.join(__dirname, '..', 'lib'), isolatedLib, { recursive: true });
    fs.cpSync(SCRIPT, path.join(isolatedUtil, 'ship-workspace-setup.js'));
    fs.rmSync(path.join(isolatedLib, 'config.js'));

    const res = spawnSync(
      process.execPath,
      [path.join(isolatedUtil, 'ship-workspace-setup.js'), '--workspace-flag', 'branch', '--derived-slug', 'my-thing'],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: path.join(repo, '.sdlc-test-state') },
      }
    );
    let json = null;
    try { json = JSON.parse(res.stdout); } catch (_) { /* left null */ }

    assert.strictEqual(res.status, 2, res.stderr);
    assert.ok(json, `expected JSON on stdout, got: ${res.stdout}`);
    assert.strictEqual(json.status, 'error');
    assert.strictEqual(json.error, 'Could not locate scripts/lib/config.js');
  } finally {
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
