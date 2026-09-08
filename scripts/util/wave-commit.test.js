'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, composeSubject, runWaveCommit } = require('./wave-commit');

const SCRIPT = path.join(__dirname, 'wave-commit.js');

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs reads --wave as a number and splits --titles on |', () => {
  const parsed = parseArgs(['node', 'wave-commit.js', '--wave', '3', '--titles', 'Add foo|Fix bar']);
  assert.strictEqual(parsed.wave, 3);
  assert.deepStrictEqual(parsed.titles, ['Add foo', 'Fix bar']);
});

test('parseArgs trims whitespace around each title and drops empty segments', () => {
  const parsed = parseArgs(['node', 'wave-commit.js', '--wave', '1', '--titles', ' Add foo | | Fix bar ']);
  assert.deepStrictEqual(parsed.titles, ['Add foo', 'Fix bar']);
});

test('parseArgs leaves wave null and titles empty when flags are absent', () => {
  const parsed = parseArgs(['node', 'wave-commit.js']);
  assert.strictEqual(parsed.wave, null);
  assert.deepStrictEqual(parsed.titles, []);
});

// ---------------------------------------------------------------------------
// composeSubject
// ---------------------------------------------------------------------------

test('composeSubject builds the wip(execute) subject with comma-separated titles', () => {
  const subject = composeSubject(3, ['Add foo', 'Fix bar']);
  assert.strictEqual(subject, 'wip(execute): wave 3 — Add foo, Fix bar');
  assert.ok(subject.length <= 72);
});

test('composeSubject truncates to exactly 72 chars, ending in an ellipsis, when the subject overflows', () => {
  const titles = [
    'Refactor the entire authentication and authorization subsystem for clarity',
    'Second title here that is also fairly long to push past the limit',
  ];
  const subject = composeSubject(3, titles);
  assert.strictEqual(subject.length, 72);
  assert.strictEqual(subject[71], '…');
  assert.ok(subject.startsWith('wip(execute): wave 3 — Refactor the entire'));
});

test('composeSubject leaves an exactly-72-char subject untouched (no ellipsis appended)', () => {
  // Prefix is 24 chars: "wip(execute): wave 3 — " — pad the title to land the
  // full subject at exactly 72 chars.
  const prefix = 'wip(execute): wave 3 — ';
  const title = 'x'.repeat(72 - prefix.length);
  const subject = composeSubject(3, [title]);
  assert.strictEqual(subject.length, 72);
  assert.ok(!subject.includes('…'));
});

// ---------------------------------------------------------------------------
// runWaveCommit — core logic with injectable spawnFn (no real git repo)
// ---------------------------------------------------------------------------

function makeSpawnFn(handlers) {
  return (cmd, args) => {
    assert.strictEqual(cmd, 'git');
    const key = args[0];
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`unexpected git subcommand: ${args.join(' ')}`);
    }
    return handler(args);
  };
}

test('runWaveCommit returns committed:true with the new sha on a real commit', () => {
  const calls = [];
  const spawnFn = makeSpawnFn({
    add: (args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; },
    commit: (args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; },
    'rev-parse': (args) => { calls.push(args); return { status: 0, stdout: 'abc1234\n', stderr: '' }; },
  });

  const result = runWaveCommit(3, ['Add foo', 'Fix bar'], { spawnFn, cwd: '/repo' });

  assert.deepStrictEqual(result, { committed: true, sha: 'abc1234', softSuccess: false });
  assert.deepStrictEqual(calls[0], ['add', '-A']);
  assert.deepStrictEqual(calls[1], ['commit', '-m', 'wip(execute): wave 3 — Add foo, Fix bar']);
  assert.deepStrictEqual(calls[2], ['rev-parse', 'HEAD']);
});

test('runWaveCommit never passes --no-verify to git commit', () => {
  const spawnFn = makeSpawnFn({
    add: () => ({ status: 0, stdout: '', stderr: '' }),
    commit: (args) => {
      assert.ok(!args.includes('--no-verify'), 'hooks must always run');
      return { status: 0, stdout: '', stderr: '' };
    },
    'rev-parse': () => ({ status: 0, stdout: 'deadbeef\n', stderr: '' }),
  });

  runWaveCommit(1, ['A'], { spawnFn, cwd: '/repo' });
});

test('runWaveCommit reports soft success (no error) when there is nothing to commit', () => {
  const spawnFn = makeSpawnFn({
    add: () => ({ status: 0, stdout: '', stderr: '' }),
    commit: () => ({ status: 1, stdout: 'On branch main\nnothing to commit, working tree clean\n', stderr: '' }),
  });

  const result = runWaveCommit(2, ['A'], { spawnFn, cwd: '/repo' });

  assert.deepStrictEqual(result, { committed: false, sha: null, softSuccess: true });
});

test('runWaveCommit reports a real error (not soft success) on an actual pre-commit hook failure', () => {
  const spawnFn = makeSpawnFn({
    add: () => ({ status: 0, stdout: '', stderr: '' }),
    commit: () => ({ status: 1, stdout: '', stderr: 'pre-commit hook rejected: lint failed\n' }),
  });

  const result = runWaveCommit(4, ['A'], { spawnFn, cwd: '/repo' });

  assert.strictEqual(result.committed, false);
  assert.strictEqual(result.sha, null);
  assert.strictEqual(result.softSuccess, false);
  assert.match(result.error, /pre-commit hook rejected/);
});

test('runWaveCommit reports an error when git add -A itself fails', () => {
  const spawnFn = makeSpawnFn({
    add: () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository\n' }),
  });

  const result = runWaveCommit(1, ['A'], { spawnFn, cwd: '/repo' });

  assert.strictEqual(result.committed, false);
  assert.strictEqual(result.sha, null);
  assert.strictEqual(result.softSuccess, false);
  assert.match(result.error, /git add -A failed/);
  assert.match(result.error, /not a git repository/);
});

test('runWaveCommit reports an error when a commit lands but rev-parse HEAD fails', () => {
  const spawnFn = makeSpawnFn({
    add: () => ({ status: 0, stdout: '', stderr: '' }),
    commit: () => ({ status: 0, stdout: '', stderr: '' }),
    'rev-parse': () => ({ status: 128, stdout: '', stderr: 'fatal: ambiguous argument HEAD\n' }),
  });

  const result = runWaveCommit(1, ['A'], { spawnFn, cwd: '/repo' });

  assert.strictEqual(result.committed, false);
  assert.strictEqual(result.sha, null);
  assert.strictEqual(result.softSuccess, false);
  assert.match(result.error, /commit landed but git rev-parse HEAD failed/);
});

// ---------------------------------------------------------------------------
// End-to-end CLI
// ---------------------------------------------------------------------------

test('CLI exits 1 with usage text when --wave and --titles are missing', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Usage: wave-commit\.js --wave <N> --titles/);
});

test('CLI exits 1 with usage text when --titles is missing', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--wave', '1'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Usage: wave-commit\.js/);
});

test('CLI reports {committed:false, reason:"empty wave title"} via JSON when --titles is whitespace-only', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--wave', '1', '--titles', '   '], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.deepStrictEqual(output, { committed: false, reason: 'empty wave title' });
});

test('CLI reports {committed:false, reason:"empty wave title"} via JSON when --titles has only empty segments', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--wave', '1', '--titles', ' | | '], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.deepStrictEqual(output, { committed: false, reason: 'empty wave title' });
});

test('CLI end-to-end against a real git repo: soft success when there is nothing to commit', () => {
  const fs = require('node:fs');
  const os = require('node:os');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-commit-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

    const result = spawnSync(process.execPath, [SCRIPT, '--wave', '1', '--titles', 'Task A'], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.deepStrictEqual(output, { committed: false, sha: null, softSuccess: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI end-to-end against a real git repo: commits a real change and returns its sha', () => {
  const fs = require('node:fs');
  const os = require('node:os');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-commit-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');

    const result = spawnSync(process.execPath, [SCRIPT, '--wave', '2', '--titles', 'Task A|Task B'], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.committed, true);
    assert.strictEqual(output.softSuccess, false);
    assert.match(output.sha, /^[0-9a-f]{40}$/);

    const log = spawnSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    assert.strictEqual(log, 'wip(execute): wave 2 — Task A, Task B');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
