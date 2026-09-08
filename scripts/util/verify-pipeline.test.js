'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { parseArgs, runVerifyPipeline } = require('./verify-pipeline');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pipeline-'));
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs forwards every argument unchanged', () => {
  const parsed = parseArgs(['node', 'verify-pipeline.js', '--pr', '42', '--timeout', '60', '--state-file', '/s.json']);
  assert.deepStrictEqual(parsed.forwardArgs, ['--pr', '42', '--timeout', '60', '--state-file', '/s.json']);
});

// ---------------------------------------------------------------------------
// runVerifyPipeline — error path
// ---------------------------------------------------------------------------

test('runVerifyPipeline exits 2 when scripts/skill/verify-pipeline.js cannot be located', () => {
  const spawnFn = () => { throw new Error('should not be called'); };
  const res = runVerifyPipeline(['node', 'verify-pipeline.js', '--pr', '1'], { spawnFn, existsFn: () => false });
  assert.strictEqual(res.exitCode, 2);
  assert.match(res.stderr, /Could not locate scripts\/skill\/verify-pipeline\.js/);
});

// ---------------------------------------------------------------------------
// Regression test for the confirmed dead-end bug: the shell original
// (verify_pipeline.sh) resolved VP_SCRIPT and errored if missing, but never
// actually invoked it. These tests assert the target script IS invoked.
// ---------------------------------------------------------------------------

test('runVerifyPipeline invokes the resolved target script with the forwarded args (mocked spawn)', () => {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, error: null };
  };
  const res = runVerifyPipeline(
    ['node', 'verify-pipeline.js', '--pr', '7', '--timeout', '120', '--state-file', '/ship-state.json'],
    { spawnFn, existsFn: () => true, targetScript: '/fake/verify-pipeline.js' }
  );
  assert.strictEqual(calls.length, 1, 'the target script must actually be invoked, not merely resolved');
  assert.strictEqual(calls[0].cmd, process.execPath);
  assert.deepStrictEqual(calls[0].args, [
    '/fake/verify-pipeline.js', '--pr', '7', '--timeout', '120', '--state-file', '/ship-state.json',
  ]);
  assert.strictEqual(res.exitCode, 0);
});

test('runVerifyPipeline really executes a real target script end-to-end (unmocked spawnSync)', () => {
  const dir = makeTempDir();
  const sentinel = path.join(dir, 'invoked.txt');
  const fakeTarget = path.join(dir, 'fake-verify-pipeline.js');
  fs.writeFileSync(
    fakeTarget,
    `require('fs').writeFileSync(${JSON.stringify(sentinel)}, process.argv.slice(2).join(' '));\n` +
      `console.log(JSON.stringify({ status: 'green', prNumber: 9 }));\n`
  );

  assert.strictEqual(fs.existsSync(sentinel), false);

  const res = runVerifyPipeline(
    ['node', 'verify-pipeline.js', '--pr', '9', '--timeout', '30'],
    { targetScript: fakeTarget }
  );

  assert.strictEqual(res.exitCode, 0);
  assert.strictEqual(fs.existsSync(sentinel), true, 'the target script must have actually run');
  assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), '--pr 9 --timeout 30');
});

// ---------------------------------------------------------------------------
// End-to-end CLI — resolution (the sibling target ships in-repo)
// ---------------------------------------------------------------------------

test('CLI resolves scripts/skill/verify-pipeline.js relative to its own location', () => {
  const realTarget = path.join(__dirname, '..', 'skill', 'verify-pipeline.js');
  assert.ok(fs.existsSync(realTarget), 'scripts/skill/verify-pipeline.js must exist for this CLI to invoke');
});
