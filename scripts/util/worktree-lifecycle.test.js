'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  resolveWorktree,
  removeWorktree,
  parseWorktreeList,
  parseArgs,
} = require('./worktree-lifecycle.js');

const SCRIPT = path.join(__dirname, 'worktree-lifecycle.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-lifecycle-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function fakeSpawn(status, stdout, stderr) {
  return () => ({ status, stdout: stdout || '', stderr: stderr || '' });
}

// ---------------------------------------------------------------------------
// parseWorktreeList
// ---------------------------------------------------------------------------

test('parseWorktreeList: parses main + linked worktree entries with branch names', () => {
  const porcelain =
    'worktree /repo/main\n' +
    'HEAD abc123\n' +
    'branch refs/heads/main\n' +
    '\n' +
    'worktree /repo/.sdlc/worktrees/feat-x\n' +
    'HEAD def456\n' +
    'branch refs/heads/feat/x\n' +
    '\n';

  const entries = parseWorktreeList(porcelain);
  assert.strictEqual(entries.length, 2);
  assert.deepStrictEqual(entries[0], { path: '/repo/main', head: 'abc123', branch: 'main' });
  assert.deepStrictEqual(entries[1], { path: '/repo/.sdlc/worktrees/feat-x', head: 'def456', branch: 'feat/x' });
});

test('parseWorktreeList: marks bare entries and tolerates missing trailing blank line', () => {
  const porcelain = 'worktree /repo/bare.git\nbare\n\nworktree /repo/wt\nHEAD abc\nbranch refs/heads/main';
  const entries = parseWorktreeList(porcelain);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].bare, true);
  assert.strictEqual(entries[1].branch, 'main');
});

test('parseWorktreeList: empty output yields empty array', () => {
  assert.deepStrictEqual(parseWorktreeList(''), []);
});

// ---------------------------------------------------------------------------
// resolveWorktree (injected spawnFn / resolveMainWorktreeFn — no real worktrees)
// ---------------------------------------------------------------------------

test('resolveWorktree: match found returns path + mainWorktree + branch + exists + matchedBy', () => {
  const porcelain =
    'worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n\n' +
    'worktree /repo/.sdlc/worktrees/feat-x\nHEAD def\nbranch refs/heads/feat/x\n\n';

  const result = resolveWorktree('feat/x', {
    spawnFn: fakeSpawn(0, porcelain, ''),
    resolveMainWorktreeFn: () => '/repo/main',
    existsFn: () => true,
  });

  assert.deepStrictEqual(result, {
    found: true,
    path: '/repo/.sdlc/worktrees/feat-x',
    mainWorktree: '/repo/main',
    branch: 'feat/x',
    exists: true,
    matchedBy: 'branch',
  });
});

test('resolveWorktree: exists:false when existsFn returns false', () => {
  const porcelain =
    'worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n\n' +
    'worktree /repo/.sdlc/worktrees/feat-x\nHEAD def\nbranch refs/heads/feat/x\n\n';

  const result = resolveWorktree('feat/x', {
    spawnFn: fakeSpawn(0, porcelain, ''),
    resolveMainWorktreeFn: () => '/repo/main',
    existsFn: () => false,
  });

  assert.strictEqual(result.found, true);
  assert.strictEqual(result.exists, false);
  assert.strictEqual(result.matchedBy, 'branch');
});

test('resolveWorktree: cwd fallback matches toplevel against entry paths when branch does not match', () => {
  const porcelain =
    'worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n\n' +
    'worktree /repo/.sdlc/worktrees/feat-x\nHEAD def\nbranch refs/heads/feat/x\n\n';

  const result = resolveWorktree('feat/does-not-exist', {
    spawnFn: fakeSpawn(0, porcelain, ''),
    resolveMainWorktreeFn: () => '/repo/main',
    toplevelFn: () => '/repo/.sdlc/worktrees/feat-x',
  });

  assert.deepStrictEqual(result, {
    found: true,
    path: '/repo/.sdlc/worktrees/feat-x',
    mainWorktree: '/repo/main',
    branch: 'feat/x',
    exists: true,
    matchedBy: 'cwd',
  });
});

test('resolveWorktree: cwd fallback with no toplevel match still returns found:false with mainWorktree', () => {
  const porcelain = 'worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n\n';

  const result = resolveWorktree('feat/does-not-exist', {
    spawnFn: fakeSpawn(0, porcelain, ''),
    resolveMainWorktreeFn: () => '/repo/main',
    toplevelFn: () => '/unrelated/dir',
  });

  assert.deepStrictEqual(result, { found: false, mainWorktree: '/repo/main' });
});

test('resolveWorktree: cwd fallback skipped when toplevelFn returns null', () => {
  const porcelain = 'worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n\n';

  const result = resolveWorktree('feat/does-not-exist', {
    spawnFn: fakeSpawn(0, porcelain, ''),
    resolveMainWorktreeFn: () => '/repo/main',
    toplevelFn: () => null,
  });

  assert.deepStrictEqual(result, { found: false, mainWorktree: '/repo/main' });
});

test('resolveWorktree: no match returns found:false with mainWorktree', () => {
  const porcelain = 'worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n\n';

  const result = resolveWorktree('feat/does-not-exist', {
    spawnFn: fakeSpawn(0, porcelain, ''),
    resolveMainWorktreeFn: () => '/repo/main',
  });

  assert.deepStrictEqual(result, { found: false, mainWorktree: '/repo/main' });
});

test('resolveWorktree: git worktree list failure surfaces stderr in error', () => {
  const result = resolveWorktree('feat/x', {
    spawnFn: fakeSpawn(1, '', 'fatal: not a git repository'),
    resolveMainWorktreeFn: () => '/repo/main',
  });

  assert.strictEqual(result.found, false);
  assert.strictEqual(result.mainWorktree, '/repo/main');
  assert.match(result.error, /git worktree list failed/);
});

test('resolveWorktree: main-worktree resolution failure returns found:false with mainWorktree:null', () => {
  const result = resolveWorktree('feat/x', {
    resolveMainWorktreeFn: () => { throw new Error('boom'); },
  });

  assert.strictEqual(result.found, false);
  assert.strictEqual(result.mainWorktree, null);
  assert.match(result.error, /Could not resolve main worktree: boom/);
});

// ---------------------------------------------------------------------------
// removeWorktree (injected spawnFn / resolveMainWorktreeFn)
// ---------------------------------------------------------------------------

test('removeWorktree: success returns removed:true with path', () => {
  const result = removeWorktree('/repo/.sdlc/worktrees/feat-x', {
    spawnFn: fakeSpawn(0, '', ''),
    resolveMainWorktreeFn: () => '/repo/main',
  });

  assert.deepStrictEqual(result, { removed: true, path: '/repo/.sdlc/worktrees/feat-x' });
});

test('removeWorktree: refuses to remove the main worktree', () => {
  const result = removeWorktree('/repo/main', {
    spawnFn: () => { throw new Error('git must not be invoked'); },
    resolveMainWorktreeFn: () => '/repo/main',
  });

  assert.deepStrictEqual(result, { error: 'refusing to remove the main worktree' });
});

test('removeWorktree: refuses when target path resolves to main worktree via relative form', () => {
  const result = removeWorktree('/repo/main/../main', {
    spawnFn: () => { throw new Error('git must not be invoked'); },
    resolveMainWorktreeFn: () => '/repo/main',
  });

  assert.deepStrictEqual(result, { error: 'refusing to remove the main worktree' });
});

test('removeWorktree: git worktree remove failure surfaces stderr in error', () => {
  const result = removeWorktree('/repo/.sdlc/worktrees/feat-x', {
    spawnFn: fakeSpawn(1, '', 'fatal: is dirty, use --force'),
    resolveMainWorktreeFn: () => '/repo/main',
  });

  assert.match(result.error, /git worktree remove failed/);
});

test('removeWorktree: main-worktree resolution failure returns error', () => {
  const result = removeWorktree('/repo/.sdlc/worktrees/feat-x', {
    resolveMainWorktreeFn: () => { throw new Error('boom'); },
  });

  assert.match(result.error, /Could not resolve main worktree: boom/);
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: resolve subcommand with --branch', () => {
  const result = parseArgs(['node', 'worktree-lifecycle.js', 'resolve', '--branch', 'feat/x']);
  assert.deepStrictEqual(result, { subcommand: 'resolve', branch: 'feat/x' });
});

test('parseArgs: remove subcommand with --path', () => {
  const result = parseArgs(['node', 'worktree-lifecycle.js', 'remove', '--path', '/repo/wt']);
  assert.deepStrictEqual(result, { subcommand: 'remove', path: '/repo/wt' });
});

test('parseArgs: no subcommand yields null', () => {
  const result = parseArgs(['node', 'worktree-lifecycle.js']);
  assert.strictEqual(result.subcommand, null);
});

// ---------------------------------------------------------------------------
// CLI (subprocess) — validation-only fail paths
// ---------------------------------------------------------------------------

test('CLI: resolve without --branch -> exit 1, JSON error on stdout', () => {
  const result = spawnSync('node', [SCRIPT, 'resolve'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.match(output.error, /Missing required argument: --branch/);
});

test('CLI: remove without --path -> exit 1, JSON error on stdout', () => {
  const result = spawnSync('node', [SCRIPT, 'remove'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.match(output.error, /Missing required argument: --path/);
});

test('CLI: unknown subcommand -> exit 2, usage on stderr', () => {
  const result = spawnSync('node', [SCRIPT, 'bogus'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /unknown subcommand "bogus"/);
  assert.match(result.stderr, /Usage: node worktree-lifecycle\.js/);
});

// ---------------------------------------------------------------------------
// End-to-end against a real git repo + real worktree (no injected fns)
// ---------------------------------------------------------------------------

test('end-to-end: resolve finds a real worktree, remove deletes it, resolve then reports not found', () => {
  const repo = makeRepo();
  const wtPath = path.join(repo, '.worktrees', 'feat-real');
  try {
    git(repo, ['worktree', 'add', wtPath, '-b', 'feat/real']);

    const found = resolveWorktree('feat/real', { cwd: repo });
    assert.strictEqual(found.found, true);
    assert.strictEqual(path.resolve(found.path), path.resolve(wtPath));
    assert.strictEqual(path.resolve(found.mainWorktree), path.resolve(repo));

    const removed = removeWorktree(found.path, { cwd: repo });
    assert.deepStrictEqual(removed, { removed: true, path: found.path });
    assert.strictEqual(fs.existsSync(wtPath), false);

    const afterRemoval = resolveWorktree('feat/real', { cwd: repo });
    assert.strictEqual(afterRemoval.found, false);
    assert.strictEqual(path.resolve(afterRemoval.mainWorktree), path.resolve(repo));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('end-to-end: removeWorktree refuses the real main worktree path', () => {
  const repo = makeRepo();
  try {
    const result = removeWorktree(repo, { cwd: repo });
    assert.deepStrictEqual(result, { error: 'refusing to remove the main worktree' });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('end-to-end CLI: resolve and remove subcommands against a real worktree', () => {
  const repo = makeRepo();
  const wtPath = path.join(repo, '.worktrees', 'feat-cli');
  try {
    git(repo, ['worktree', 'add', wtPath, '-b', 'feat/cli']);

    const resolveResult = spawnSync('node', [SCRIPT, 'resolve', '--branch', 'feat/cli'], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.strictEqual(resolveResult.status, 0, resolveResult.stderr);
    const resolved = JSON.parse(resolveResult.stdout);
    assert.strictEqual(resolved.found, true);
    assert.strictEqual(path.resolve(resolved.path), path.resolve(wtPath));

    const removeResult = spawnSync('node', [SCRIPT, 'remove', '--path', resolved.path], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.strictEqual(removeResult.status, 0, removeResult.stderr);
    const removed = JSON.parse(removeResult.stdout);
    assert.strictEqual(removed.removed, true);
    assert.strictEqual(fs.existsSync(wtPath), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
