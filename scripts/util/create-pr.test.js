'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const { parseArgs, runCreatePr } = require('./create-pr');

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs forwards every argument unchanged to gh pr create', () => {
  const parsed = parseArgs(['node', 'create-pr.js', '--title', 'feat: x', '--body-file', '/b.md']);
  assert.deepStrictEqual(parsed.forwardArgs, ['--title', 'feat: x', '--body-file', '/b.md']);
});

// ---------------------------------------------------------------------------
// runCreatePr — success path (no `gh` binary is ever actually invoked; the
// spawn boundary is stubbed throughout, per the fact sheet's "tests must
// not invoke the real gh binary" instruction).
// ---------------------------------------------------------------------------

test('runCreatePr exits 0 and never touches the recovery script when gh pr create succeeds', () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0, error: null, stderr: '' };
  };
  const res = runCreatePr(['node', 'create-pr.js', '--title', 'feat: x'], {
    spawnFn,
    existsFn: () => { throw new Error('existsFn should not be called on the success path'); },
  });
  assert.strictEqual(res.exitCode, 0);
  assert.strictEqual(calls.length, 1, 'only gh pr create should be invoked');
  assert.strictEqual(calls[0].cmd, 'gh');
  assert.deepStrictEqual(calls[0].args, ['pr', 'create', '--title', 'feat: x']);
});

// ---------------------------------------------------------------------------
// runCreatePr — recovery script missing
// ---------------------------------------------------------------------------

test('runCreatePr exits 2 when pr-recover-gh-account.js cannot be located after a gh failure', () => {
  const spawnFn = (cmd) => {
    if (cmd === 'gh') return { status: 1, error: null, stderr: 'permission denied\n' };
    throw new Error('recovery script should not be invoked when it cannot be located');
  };
  const res = runCreatePr(['node', 'create-pr.js'], {
    spawnFn,
    existsFn: () => false,
  });
  assert.strictEqual(res.exitCode, 2);
  assert.match(res.stderr, /Could not locate scripts\/skill\/pr-recover-gh-account\.js/);
});

// ---------------------------------------------------------------------------
// runCreatePr — recovery path: gh's stderr goes to a temp file (the
// createOutputFile()-style os.tmpdir() replacement for mktemp), the
// recovery script is invoked with --error-file <path>, and the temp file
// is cleaned up afterward.
// ---------------------------------------------------------------------------

test('runCreatePr writes gh stderr to a temp file, invokes the recovery script with --error-file, and cleans up', () => {
  const FAKE_ERR_FILE = '/fake/tmp/gh-pr-create-err-abc123.json';
  const calls = [];
  const writes = [];
  const unlinks = [];

  const spawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'gh') {
      return { status: 1, error: null, stderr: 'does not have the correct permissions\n' };
    }
    return { status: 0, error: null, stdout: '{"switched":true}\n' };
  };

  const res = runCreatePr(['node', 'create-pr.js', '--title', 'feat: x'], {
    spawnFn,
    existsFn: () => true,
    recoverScript: '/fake/pr-recover-gh-account.js',
    createOutputFileFn: (prefix) => {
      assert.strictEqual(prefix, 'gh-pr-create-err');
      return FAKE_ERR_FILE;
    },
    writeErrFileFn: (filePath, content) => { writes.push({ filePath, content }); },
    unlinkFn: (filePath) => { unlinks.push(filePath); },
  });

  assert.strictEqual(calls.length, 2, 'gh pr create, then the recovery script');
  assert.strictEqual(calls[0].cmd, 'gh');
  assert.strictEqual(calls[1].cmd, process.execPath);
  assert.deepStrictEqual(calls[1].args, ['/fake/pr-recover-gh-account.js', '--error-file', FAKE_ERR_FILE]);

  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].filePath, FAKE_ERR_FILE);
  assert.strictEqual(writes[0].content, 'does not have the correct permissions\n');

  assert.deepStrictEqual(unlinks, [FAKE_ERR_FILE], 'the temp err file must be removed (mirrors `rm -f` in the shell original)');

  assert.strictEqual(res.exitCode, 1, 'the original gh exit code is forwarded');
  assert.strictEqual(res.stdout, '{"switched":true}\n', "the recovery script's JSON verdict is surfaced on stdout");
});

test('runCreatePr forwards the gh exit code even when the recovery script itself errors', () => {
  const spawnFn = (cmd) => {
    if (cmd === 'gh') return { status: 1, error: null, stderr: 'boom\n' };
    return { status: 2, error: { message: 'spawn failed' } };
  };
  const res = runCreatePr(['node', 'create-pr.js'], {
    spawnFn,
    existsFn: () => true,
    createOutputFileFn: () => '/fake/err.json',
    writeErrFileFn: () => {},
    unlinkFn: () => {},
  });
  assert.strictEqual(res.exitCode, 1, 'the original gh failure exit code, not the recovery script crash');
  assert.match(res.stderr, /failed to invoke pr-recover-gh-account\.js/);
});

// ---------------------------------------------------------------------------
// End-to-end CLI — resolution (the sibling target ships in-repo)
// ---------------------------------------------------------------------------

test('CLI resolves scripts/skill/pr-recover-gh-account.js relative to its own location', () => {
  const realTarget = path.join(__dirname, '..', 'skill', 'pr-recover-gh-account.js');
  assert.ok(fs.existsSync(realTarget), 'scripts/skill/pr-recover-gh-account.js must exist for this CLI to invoke');
});
