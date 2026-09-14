'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  git,
  stderrOf,
  dequote,
  checkCleanTree,
  hasUntrackedConfig,
} = require('./clean-tree');

describe('stderrOf', () => {
  test('handles null or undefined result', () => {
    assert.strictEqual(stderrOf(null), '(no result)');
    assert.strictEqual(stderrOf(undefined), '(no result)');
  });

  test('returns error message if present', () => {
    assert.strictEqual(stderrOf({ error: new Error('spawn failed') }), 'spawn failed');
  });

  test('returns trimmed stderr if present', () => {
    assert.strictEqual(stderrOf({ stderr: '  fatal: not a git repo  \n' }), 'fatal: not a git repo');
  });

  test('returns exit status when no stderr or error', () => {
    assert.strictEqual(stderrOf({ status: 128 }), 'exit 128');
  });
});

describe('dequote', () => {
  test('returns unquoted string as-is', () => {
    assert.strictEqual(dequote('foo/bar.txt'), 'foo/bar.txt');
    assert.strictEqual(dequote(''), '');
    assert.strictEqual(dequote('a'), 'a');
  });

  test('parses JSON-quoted strings', () => {
    assert.strictEqual(dequote('"foo/bar.txt"'), 'foo/bar.txt');
    assert.strictEqual(dequote('"path with \\"quotes\\""'), 'path with "quotes"');
  });

  test('falls back to slice if JSON.parse fails', () => {
    assert.strictEqual(dequote('"invalid\\json"'), 'invalid\\json');
  });
});

describe('checkCleanTree and hasUntrackedConfig with git repo', () => {
  function createTempGitRepo() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-tree-test-'));
    spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tmpDir, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: tmpDir, stdio: 'ignore' });
    return tmpDir;
  }

  test('clean repository returns no problems', () => {
    const repo = createTempGitRepo();
    try {
      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'hello');
      spawnSync('git', ['add', 'tracked.txt'], { cwd: repo, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });

      const problems = checkCleanTree(repo, {
        pendingDir: '.sdlc/learnings/pending',
        pendingPrefix: '.sdlc/learnings/pending/',
        actionVerb: 'assimilating',
      });
      assert.deepStrictEqual(problems, []);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('reports tracked files with uncommitted changes', () => {
    const repo = createTempGitRepo();
    try {
      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'hello');
      spawnSync('git', ['add', 'tracked.txt'], { cwd: repo, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });

      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'modified');

      const problems = checkCleanTree(repo, {
        pendingDir: '.sdlc/learnings/pending',
        pendingPrefix: '.sdlc/learnings/pending/',
        actionVerb: 'assimilating',
      });
      assert.strictEqual(problems.length, 1);
      assert.match(problems[0], /working tree is dirty — tracked files with uncommitted changes: tracked\.txt/);
      assert.match(problems[0], /before assimilating learnings/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('reports untracked files outside pendingPrefix and exempts pendingPrefix', () => {
    const repo = createTempGitRepo();
    try {
      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'hello');
      spawnSync('git', ['add', 'tracked.txt'], { cwd: repo, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });

      fs.mkdirSync(path.join(repo, '.sdlc/learnings/pending'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.sdlc/learnings/pending/learn1.md'), 'learning');

      fs.writeFileSync(path.join(repo, 'stray.txt'), 'untracked');

      const problems = checkCleanTree(repo, {
        pendingDir: '.sdlc/learnings/pending',
        pendingPrefix: '.sdlc/learnings/pending/',
        actionVerb: 'rejecting',
      });
      assert.strictEqual(problems.length, 1);
      assert.match(problems[0], /untracked entries outside \.sdlc\/learnings\/pending\/: stray\.txt/);
      assert.match(problems[0], /before rejecting learnings/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('reports failure when git status exits with non-zero code', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    try {
      const problems = checkCleanTree(nonGitDir, {
        pendingDir: '.sdlc/learnings/pending',
        pendingPrefix: '.sdlc/learnings/pending/',
        actionVerb: 'assimilating',
      });
      assert.strictEqual(problems.length, 1);
      assert.match(problems[0], /clean-tree check failed: git status --untracked-files=no:/);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  test('hasUntrackedConfig detects non-existent, tracked, and untracked config', () => {
    const repo = createTempGitRepo();
    try {
      assert.strictEqual(hasUntrackedConfig(repo, '.sdlc/config.json'), false);

      fs.mkdirSync(path.join(repo, '.sdlc'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.sdlc/config.json'), '{}');
      assert.strictEqual(hasUntrackedConfig(repo, '.sdlc/config.json'), true);

      spawnSync('git', ['add', '.sdlc/config.json'], { cwd: repo, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'add config'], { cwd: repo, stdio: 'ignore' });
      assert.strictEqual(hasUntrackedConfig(repo, '.sdlc/config.json'), false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
