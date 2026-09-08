'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { parseArgs, stagePostExecute, commitLearnings, commitOpenspecArchive } = require('./ship-git-ops');

const SCRIPT = path.join(__dirname, 'ship-git-ops.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-git-ops-'));
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

test('parseArgs reads stage-post-execute with no flags', () => {
  const parsed = parseArgs(['node', 'ship-git-ops.js', 'stage-post-execute']);
  assert.strictEqual(parsed.command, 'stage-post-execute');
  assert.strictEqual(parsed.change, null);
});

test('parseArgs reads commit-openspec-archive --change <name>', () => {
  const parsed = parseArgs(['node', 'ship-git-ops.js', 'commit-openspec-archive', '--change', 'add-foo']);
  assert.strictEqual(parsed.command, 'commit-openspec-archive');
  assert.strictEqual(parsed.change, 'add-foo');
});

// ---------------------------------------------------------------------------
// stagePostExecute — injectable spawnFn, no real git repo required
// ---------------------------------------------------------------------------

test('stagePostExecute returns the staged file list on success', () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push(args);
    if (args[0] === 'add') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'diff') {
      return { status: 0, stdout: 'src/routes/index.ts\nsrc/middleware/auth.ts\n', stderr: '' };
    }
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const result = stagePostExecute({ spawnFn });
  assert.deepStrictEqual(result, { staged: ['src/routes/index.ts', 'src/middleware/auth.ts'] });
  assert.deepStrictEqual(calls[0], ['add', '-A', '--', ':!.sdlc/']);
  assert.deepStrictEqual(calls[1], ['diff', '--cached', '--name-only']);
});

test('stagePostExecute returns an empty staged list when nothing changed', () => {
  const spawnFn = (cmd, args) => {
    if (args[0] === 'add') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'diff') return { status: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const result = stagePostExecute({ spawnFn });
  assert.deepStrictEqual(result, { staged: [] });
});

test('stagePostExecute reports an error when git add fails', () => {
  const spawnFn = () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' });
  const result = stagePostExecute({ spawnFn });
  assert.deepStrictEqual(result.staged, []);
  assert.match(result.error, /not a git repository/);
});

// ---------------------------------------------------------------------------
// commitLearnings — injectable spawnFn
// ---------------------------------------------------------------------------

test('commitLearnings returns committed:false reason:clean when git diff --quiet reports no diff', () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = commitLearnings({ spawnFn });
  assert.deepStrictEqual(result, { committed: false, reason: 'clean' });
  // Only the diff check ran — no add/commit/push.
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], ['diff', '--quiet', '--', '.sdlc/learnings/log.md']);
});

test('commitLearnings commits and pushes on a full success path', () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push(args);
    if (args[0] === 'diff') return { status: 1, stdout: '', stderr: '' };
    if (args[0] === 'add') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'commit') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'push') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const result = commitLearnings({ spawnFn });
  assert.deepStrictEqual(result, { committed: true, pushed: true });
  assert.deepStrictEqual(calls[1], ['add', '.sdlc/learnings/log.md']);
  assert.deepStrictEqual(calls[2], ['commit', '-m', 'chore(ship-sdlc): capture pipeline learnings']);
  assert.deepStrictEqual(calls[3], ['push']);
});

test('commitLearnings reports push failure as non-fatal (committed stays true)', () => {
  const spawnFn = (cmd, args) => {
    if (args[0] === 'diff') return { status: 1, stdout: '', stderr: '' };
    if (args[0] === 'add') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'commit') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'push') return { status: 1, stdout: '', stderr: 'fatal: could not read from remote' };
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const result = commitLearnings({ spawnFn });
  assert.strictEqual(result.committed, true);
  assert.strictEqual(result.pushed, false);
  assert.match(result.reason, /could not read from remote/);
});

test('commitLearnings flags dirty when the post-condition git status --porcelain is not empty', () => {
  const spawnFn = (cmd, args) => {
    if (args[0] === 'diff') return { status: 1, stdout: '', stderr: '' };
    if (args[0] === 'add') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'commit') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'push') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'status') return { status: 0, stdout: ' M some-other-file.txt', stderr: '' };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const result = commitLearnings({ spawnFn });
  assert.strictEqual(result.committed, true);
  assert.strictEqual(result.pushed, true);
  assert.strictEqual(result.dirty, true);
  assert.match(result.postConditionReason, /not clean/);
});

test('commitLearnings returns committed:false with a reason when git add fails', () => {
  const spawnFn = (cmd, args) => {
    if (args[0] === 'diff') return { status: 1, stdout: '', stderr: '' };
    if (args[0] === 'add') return { status: 1, stdout: '', stderr: 'fatal: pathspec did not match' };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const result = commitLearnings({ spawnFn });
  assert.strictEqual(result.committed, false);
  assert.match(result.reason, /pathspec did not match/);
});

test('commitLearnings returns committed:false with a reason when git commit fails', () => {
  const spawnFn = (cmd, args) => {
    if (args[0] === 'diff') return { status: 1, stdout: '', stderr: '' };
    if (args[0] === 'add') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'commit') return { status: 1, stdout: '', stderr: 'hook declined' };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const result = commitLearnings({ spawnFn });
  assert.strictEqual(result.committed, false);
  assert.match(result.reason, /hook declined/);
});

// ---------------------------------------------------------------------------
// commitOpenspecArchive — injectable spawnFn + isArchivedFn
// ---------------------------------------------------------------------------

test('commitOpenspecArchive returns not-archived and skips staging when isArchived is false', () => {
  const calls = [];
  const spawnFn = (cmd, args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; };
  const result = commitOpenspecArchive('add-foo', { spawnFn, isArchivedFn: () => false });
  assert.deepStrictEqual(result, { committed: false, reason: 'not-archived' });
  assert.strictEqual(calls.length, 0);
});

test('commitOpenspecArchive stages and commits when isArchived is true', () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = commitOpenspecArchive('add-foo', { spawnFn, isArchivedFn: () => true });
  assert.deepStrictEqual(result, { committed: true });
  assert.deepStrictEqual(calls[0], ['add', 'openspec/']);
  assert.deepStrictEqual(calls[1], ['commit', '-m', 'chore(openspec): archive add-foo']);
});

test('commitOpenspecArchive returns committed:false reason:clean when there is nothing to commit', () => {
  const spawnFn = (cmd, args) => {
    if (args[0] === 'add') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'commit') return { status: 1, stdout: 'nothing to commit, working tree clean', stderr: '' };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const result = commitOpenspecArchive('add-foo', { spawnFn, isArchivedFn: () => true });
  assert.deepStrictEqual(result, { committed: false, reason: 'clean' });
});

test('commitOpenspecArchive returns committed:false with a reason when git add fails', () => {
  const spawnFn = () => ({ status: 128, stdout: '', stderr: 'fatal: pathspec openspec/ did not match any files' });
  const result = commitOpenspecArchive('add-foo', { spawnFn, isArchivedFn: () => true });
  assert.strictEqual(result.committed, false);
  assert.match(result.reason, /did not match any files/);
});

test('commitOpenspecArchive returns committed:false with a reason on a real commit failure', () => {
  const spawnFn = (cmd, args) => {
    if (args[0] === 'add') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'commit') return { status: 1, stdout: '', stderr: 'hook declined' };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const result = commitOpenspecArchive('add-foo', { spawnFn, isArchivedFn: () => true });
  assert.strictEqual(result.committed, false);
  assert.match(result.reason, /hook declined/);
});

// ---------------------------------------------------------------------------
// End-to-end CLI against a real repo
// ---------------------------------------------------------------------------

test('CLI stage-post-execute: stages new + modified files, excludes .sdlc/', () => {
  const dir = makeRepo();
  try {
    fs.mkdirSync(path.join(dir, '.sdlc'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.sdlc', 'state.json'), '{}');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new');

    const result = run(dir, ['stage-post-execute']);
    assert.strictEqual(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepStrictEqual(parsed.staged.sort(), ['a.txt', 'b.txt']);

    const staged = git(dir, ['diff', '--cached', '--name-only']);
    assert.ok(!staged.includes('.sdlc/'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI commit-learnings: clean tree -> committed:false reason:clean, exit 0', () => {
  const dir = makeRepo();
  try {
    const result = run(dir, ['commit-learnings']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), { committed: false, reason: 'clean' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI commit-learnings: new learnings log -> committed:true (push fails offline, still exit 0)', () => {
  const dir = makeRepo();
  try {
    fs.mkdirSync(path.join(dir, '.sdlc', 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.sdlc', 'learnings', 'log.md'), '# learnings\n- entry\n');
    git(dir, ['add', '.sdlc/learnings/log.md']);
    git(dir, ['commit', '-q', '-m', 'seed learnings file']);
    fs.appendFileSync(path.join(dir, '.sdlc', 'learnings', 'log.md'), '- another entry\n');

    const result = run(dir, ['commit-learnings']);
    assert.strictEqual(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.committed, true);
    assert.strictEqual(parsed.pushed, false); // no remote configured in the test repo
    assert.ok(parsed.reason);

    const log = git(dir, ['log', '-1', '--format=%s']);
    assert.strictEqual(log.trim(), 'chore(ship-sdlc): capture pipeline learnings');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI commit-openspec-archive: not archived -> committed:false reason:not-archived, exit 0, no staging', () => {
  const dir = makeRepo();
  try {
    fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'add-foo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'openspec', 'changes', 'add-foo', 'proposal.md'), '# proposal\n');

    const result = run(dir, ['commit-openspec-archive', '--change', 'add-foo']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), { committed: false, reason: 'not-archived' });

    const status = git(dir, ['status', '--porcelain']);
    assert.match(status, /openspec/); // still untracked — nothing was staged
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI commit-openspec-archive: archived -> stages openspec/ and commits, exit 0', () => {
  const dir = makeRepo();
  try {
    fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'archive', '2026-09-02-add-foo'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'openspec', 'changes', 'archive', '2026-09-02-add-foo', 'proposal.md'),
      '# proposal\n'
    );

    const result = run(dir, ['commit-openspec-archive', '--change', 'add-foo']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), { committed: true });

    const log = git(dir, ['log', '-1', '--format=%s']);
    assert.strictEqual(log.trim(), 'chore(openspec): archive add-foo');

    const status = git(dir, ['status', '--porcelain']);
    assert.strictEqual(status.trim(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI commit-openspec-archive without --change prints usage and exits 1', () => {
  const dir = makeRepo();
  try {
    const result = run(dir, ['commit-openspec-archive']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Usage:\n {2}ship-git-ops\.js stage-post-execute/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI with no recognized command prints usage and exits 1', () => {
  const dir = makeRepo();
  try {
    const result = run(dir, []);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Usage:\n {2}ship-git-ops\.js stage-post-execute/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
