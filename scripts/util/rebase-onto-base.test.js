'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, resolveRebaseOntoBase } = require('./rebase-onto-base');

const SCRIPT = path.join(__dirname, 'rebase-onto-base.js');

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs reads --base', () => {
  const parsed = parseArgs(['node', 'rebase-onto-base.js', '--base', 'main']);
  assert.strictEqual(parsed.base, 'main');
});

test('parseArgs leaves base null when --base is absent', () => {
  const parsed = parseArgs(['node', 'rebase-onto-base.js']);
  assert.strictEqual(parsed.base, null);
});

test('parseArgs defaults remote to origin when --remote is absent', () => {
  const parsed = parseArgs(['node', 'rebase-onto-base.js', '--base', 'main']);
  assert.strictEqual(parsed.remote, 'origin');
});

test('parseArgs reads --remote', () => {
  const parsed = parseArgs(['node', 'rebase-onto-base.js', '--base', 'main', '--remote', 'upstream']);
  assert.strictEqual(parsed.remote, 'upstream');
});

// ---------------------------------------------------------------------------
// resolveRebaseOntoBase — core logic with injectable spawnFn
// ---------------------------------------------------------------------------

function makeSpawnFn(handlers) {
  return (cmd, args, opts) => {
    assert.strictEqual(cmd, 'git');
    const key = args[0];
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`unexpected git subcommand: ${args.join(' ')}`);
    }
    return handler(args, opts);
  };
}

test('resolveRebaseOntoBase returns up_to_date when base is already an ancestor of HEAD', () => {
  const calls = [];
  const spawnFn = makeSpawnFn({
    fetch: (args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; },
    'merge-base': (args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; },
  });

  const result = resolveRebaseOntoBase('main', { spawnFn, cwd: '/repo' });

  assert.deepStrictEqual(result, { status: 'up_to_date' });
  assert.deepStrictEqual(calls[0], ['fetch', 'origin', 'main']);
  assert.deepStrictEqual(calls[1], ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
});

test('resolveRebaseOntoBase reports clean with the new HEAD sha on a successful rebase', () => {
  const calls = [];
  const spawnFn = makeSpawnFn({
    fetch: (args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; },
    'merge-base': (args) => { calls.push(args); return { status: 1, stdout: '', stderr: '' }; },
    rebase: (args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; },
    'rev-parse': (args) => { calls.push(args); return { status: 0, stdout: 'deadbeef1234\n', stderr: '' }; },
  });

  const result = resolveRebaseOntoBase('main', { spawnFn, cwd: '/repo' });

  assert.deepStrictEqual(result, { status: 'clean', sha: 'deadbeef1234' });
  assert.deepStrictEqual(calls[2], ['rebase', 'origin/main']);
  assert.deepStrictEqual(calls[3], ['rev-parse', 'HEAD']);
});

test('resolveRebaseOntoBase reports conflicts and aborts the rebase, leaving no mid-rebase state', () => {
  const calls = [];
  const spawnFn = makeSpawnFn({
    fetch: (args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; },
    'merge-base': (args) => { calls.push(args); return { status: 1, stdout: '', stderr: '' }; },
    rebase: (args) => {
      calls.push(args);
      if (args[1] === '--abort') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: 'CONFLICT' };
    },
    diff: (args) => { calls.push(args); return { status: 0, stdout: 'path/a.js\npath/b.js\n', stderr: '' }; },
  });

  const result = resolveRebaseOntoBase('main', { spawnFn, cwd: '/repo' });

  assert.deepStrictEqual(result, { status: 'conflicts', files: ['path/a.js', 'path/b.js'] });
  // rebase --abort must be the last call so the repo is not left mid-rebase.
  const last = calls[calls.length - 1];
  assert.deepStrictEqual(last, ['rebase', '--abort']);
});

test('resolveRebaseOntoBase reports an empty file list when the conflict diff has no output', () => {
  const spawnFn = makeSpawnFn({
    fetch: () => ({ status: 0, stdout: '', stderr: '' }),
    'merge-base': () => ({ status: 1, stdout: '', stderr: '' }),
    rebase: (args) => (args[1] === '--abort' ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: '' }),
    diff: () => ({ status: 0, stdout: '', stderr: '' }),
  });

  const result = resolveRebaseOntoBase('main', { spawnFn, cwd: '/repo' });

  assert.deepStrictEqual(result, { status: 'conflicts', files: [] });
});

test('resolveRebaseOntoBase uses a custom remote when provided', () => {
  const calls = [];
  const spawnFn = makeSpawnFn({
    fetch: (args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; },
    'merge-base': (args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; },
  });

  resolveRebaseOntoBase('main', { spawnFn, cwd: '/repo', remote: 'upstream' });

  assert.deepStrictEqual(calls[0], ['fetch', 'upstream', 'main']);
  assert.deepStrictEqual(calls[1], ['merge-base', '--is-ancestor', 'upstream/main', 'HEAD']);
});

test('resolveRebaseOntoBase passes the injected cwd through to every spawn call', () => {
  const injectedCwd = '/some/worktree';
  const optsSeen = [];
  const spawnFn = makeSpawnFn({
    fetch: (args, opts) => { optsSeen.push(opts); return { status: 0, stdout: '', stderr: '' }; },
    'merge-base': (args, opts) => { optsSeen.push(opts); return { status: 1, stdout: '', stderr: '' }; },
    rebase: (args, opts) => { optsSeen.push(opts); return { status: 0, stdout: '', stderr: '' }; },
    'rev-parse': (args, opts) => { optsSeen.push(opts); return { status: 0, stdout: 'deadbeef1234\n', stderr: '' }; },
  });

  resolveRebaseOntoBase('main', { spawnFn, cwd: injectedCwd });

  assert.ok(optsSeen.length > 0);
  for (const opts of optsSeen) {
    assert.strictEqual(opts.cwd, injectedCwd);
  }
});

test('resolveRebaseOntoBase returns fetch_failed with the trimmed stderr and makes no further spawns when fetch fails', () => {
  const calls = [];
  const spawnFn = makeSpawnFn({
    fetch: (args) => { calls.push(args); return { status: 128, stdout: '', stderr: '  fatal: unable to access remote  \n' }; },
  });

  const result = resolveRebaseOntoBase('main', { spawnFn, cwd: '/repo' });

  assert.deepStrictEqual(result, {
    status: 'fetch_failed',
    remote: 'origin',
    base: 'main',
    error: 'fatal: unable to access remote',
  });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], ['fetch', 'origin', 'main']);
});

test('resolveRebaseOntoBase reports fetch_failed for a custom remote', () => {
  const spawnFn = makeSpawnFn({
    fetch: (args) => ({ status: 1, stdout: '', stderr: 'could not read from remote' }),
  });

  const result = resolveRebaseOntoBase('main', { spawnFn, cwd: '/repo', remote: 'upstream' });

  assert.deepStrictEqual(result, {
    status: 'fetch_failed',
    remote: 'upstream',
    base: 'main',
    error: 'could not read from remote',
  });
});

// ---------------------------------------------------------------------------
// End-to-end CLI
// ---------------------------------------------------------------------------

test('CLI exits 1 with usage text when --base is missing', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Usage: rebase-onto-base\.js --base <branch>/);
});
