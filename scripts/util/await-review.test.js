'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { parseArgs, runAwaitReview } = require('./await-review');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'await-review-'));
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs forwards every argument unchanged', () => {
  const parsed = parseArgs(['node', 'await-review.js', '--pr', '42', '--timeout', '60', '--state-file', '/s.json']);
  assert.deepStrictEqual(parsed.forwardArgs, ['--pr', '42', '--timeout', '60', '--state-file', '/s.json']);
});

// ---------------------------------------------------------------------------
// runAwaitReview — error path
// ---------------------------------------------------------------------------

test('runAwaitReview exits 2 when scripts/skill/await-remote-review.js cannot be located', () => {
  const spawnFn = () => { throw new Error('should not be called'); };
  const res = runAwaitReview(['node', 'await-review.js', '--pr', '1'], { spawnFn, existsFn: () => false });
  assert.strictEqual(res.exitCode, 2);
  assert.match(res.stderr, /Could not locate scripts\/skill\/await-remote-review\.js/);
});

// ---------------------------------------------------------------------------
// Regression test for the confirmed dead-end bug: the shell original
// (await_review.sh) resolved AR_SCRIPT and errored if missing, but never
// actually invoked it. These tests assert the target script IS invoked.
// ---------------------------------------------------------------------------

test('runAwaitReview invokes the resolved target script with the forwarded args (mocked spawn)', () => {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, error: null };
  };
  const res = runAwaitReview(
    ['node', 'await-review.js', '--pr', '7', '--reviewers', 'copilot', '--state-file', '/ship-state.json'],
    { spawnFn, existsFn: () => true, targetScript: '/fake/await-remote-review.js' }
  );
  assert.strictEqual(calls.length, 1, 'the target script must actually be invoked, not merely resolved');
  assert.strictEqual(calls[0].cmd, process.execPath);
  assert.deepStrictEqual(calls[0].args, [
    '/fake/await-remote-review.js', '--pr', '7', '--reviewers', 'copilot', '--state-file', '/ship-state.json',
  ]);
  assert.strictEqual(res.exitCode, 0);
});

test('runAwaitReview really executes a real target script end-to-end (unmocked spawnSync)', () => {
  const dir = makeTempDir();
  const sentinel = path.join(dir, 'invoked.txt');
  const fakeTarget = path.join(dir, 'fake-await-remote-review.js');
  fs.writeFileSync(
    fakeTarget,
    `require('fs').writeFileSync(${JSON.stringify(sentinel)}, process.argv.slice(2).join(' '));\n` +
      `console.log(JSON.stringify({ status: 'timeout', waitedSeconds: 0, reviewersWatched: ['copilot'], prNumber: 9 }));\n`
  );

  assert.strictEqual(fs.existsSync(sentinel), false);

  const res = runAwaitReview(
    ['node', 'await-review.js', '--pr', '9', '--reviewers', 'copilot'],
    { targetScript: fakeTarget }
  );

  assert.strictEqual(res.exitCode, 0);
  assert.strictEqual(fs.existsSync(sentinel), true, 'the target script must have actually run');
  assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), '--pr 9 --reviewers copilot');
});

// ---------------------------------------------------------------------------
// End-to-end CLI — resolution (the sibling target ships in-repo)
// ---------------------------------------------------------------------------

test('CLI resolves scripts/skill/await-remote-review.js relative to its own location', () => {
  const realTarget = path.join(__dirname, '..', 'skill', 'await-remote-review.js');
  assert.ok(fs.existsSync(realTarget), 'scripts/skill/await-remote-review.js must exist for this CLI to invoke');
});
