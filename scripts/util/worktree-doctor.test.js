'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseWorktreeList, slugify } = require('./worktree-doctor.js');

const SCRIPT = path.join(__dirname, 'worktree-doctor.js');

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

test('slugify: lowercases, collapses runs of non-alphanumerics, trims leading/trailing hyphens', () => {
  assert.strictEqual(slugify('Feat/Add-Thing_v2'), 'feat-add-thing-v2');
  assert.strictEqual(slugify('--edge--'), 'edge');
});

// ---------------------------------------------------------------------------
// parseWorktreeList
// ---------------------------------------------------------------------------

test('parseWorktreeList: parses main worktree plus one linked worktree', () => {
  const output = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/.sdlc/worktrees/feat-x',
    'HEAD def456',
    'branch refs/heads/feat/x',
    '',
  ].join('\n');

  const entries = parseWorktreeList(output);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].worktreePath, '/repo');
  assert.strictEqual(entries[0].branch, 'main');
  assert.strictEqual(entries[1].worktreePath, '/repo/.sdlc/worktrees/feat-x');
  assert.strictEqual(entries[1].branch, 'feat/x');
});

test('parseWorktreeList: marks bare repositories', () => {
  const output = ['worktree /repo.git', 'bare', ''].join('\n');
  const entries = parseWorktreeList(output);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].bare, true);
});

test('parseWorktreeList: entry with no trailing blank line is still captured', () => {
  const output = ['worktree /repo', 'HEAD abc123', 'branch refs/heads/main'].join('\n');
  const entries = parseWorktreeList(output);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].worktreePath, '/repo');
});

// ---------------------------------------------------------------------------
// CLI (subprocess) — no-linked-worktrees happy path
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('CLI: repo with no linked worktrees -> 0 issues, exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-doctor-'));
  try {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);

    const result = spawnSync('node', [SCRIPT, '--json'], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.ok, true);
    assert.deepStrictEqual(output.worktrees, []);
    assert.deepStrictEqual(output.issues, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
