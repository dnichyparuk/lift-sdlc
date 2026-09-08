'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { parseArgs, runPlanModeCheck } = require('./plan-mode-check');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-mode-check-'));
}

// ---------------------------------------------------------------------------
// parseArgs — $ARGUMENTS template-substitution compatibility
// ---------------------------------------------------------------------------

test('parseArgs forwards every argument unchanged (the $ARGUMENTS shape)', () => {
  const parsed = parseArgs(['node', 'plan-mode-check.js', '--auto', '--steps', 'execute,commit']);
  assert.deepStrictEqual(parsed.forwardArgs, ['--auto', '--steps', 'execute,commit']);
});

test('parseArgs forwards nothing when no arguments are given', () => {
  const parsed = parseArgs(['node', 'plan-mode-check.js']);
  assert.deepStrictEqual(parsed.forwardArgs, []);
});

// ---------------------------------------------------------------------------
// runPlanModeCheck — error path
// ---------------------------------------------------------------------------

test('runPlanModeCheck exits 2 when scripts/skill/ship.js cannot be located', () => {
  const spawnFn = () => { throw new Error('should not be called'); };
  const res = runPlanModeCheck(['node', 'plan-mode-check.js'], { spawnFn, existsFn: () => false });
  assert.strictEqual(res.exitCode, 2);
  assert.match(res.stderr, /Could not locate scripts\/skill\/ship\.js/);
  assert.deepStrictEqual(res.lines, []);
});

// ---------------------------------------------------------------------------
// runPlanModeCheck — invokes ship.js with the two fixed flags plus $ARGUMENTS,
// and always "succeeds" (exit 0) once the target ran — matching the shell
// original, which had no trailing `exit` statement.
// ---------------------------------------------------------------------------

test('runPlanModeCheck invokes ship.js with --output-file --plan-mode-blocked plus forwarded args (mocked spawn)', () => {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: '/tmp/ship-prepare-output.json\n', error: null };
  };
  const res = runPlanModeCheck(
    ['node', 'plan-mode-check.js', '--auto', '--steps', 'execute'],
    { spawnFn, existsFn: () => true, shipScript: '/fake/ship.js' }
  );
  assert.strictEqual(calls.length, 1, 'ship.js must actually be invoked, not merely resolved');
  assert.deepStrictEqual(calls[0].args, [
    '/fake/ship.js', '--output-file', '--plan-mode-blocked', '--auto', '--steps', 'execute',
  ]);
  assert.strictEqual(res.exitCode, 0);
  assert.deepStrictEqual(res.lines, [
    'PLAN_MODE_OUTPUT_FILE=/tmp/ship-prepare-output.json',
    'PLAN_MODE_EXIT=0',
    'PLAN_MODE_OUTPUT_FILE: /tmp/ship-prepare-output.json',
    'STATUS: 0',
  ]);
});

test('runPlanModeCheck still reports STATUS with a non-zero ship.js exit but exits this process 0 (mirrors the shell original having no trailing exit)', () => {
  const spawnFn = () => ({ status: 1, stdout: '/tmp/blocked-output.json\n', error: null });
  const res = runPlanModeCheck(['node', 'plan-mode-check.js'], { spawnFn, existsFn: () => true });
  assert.strictEqual(res.exitCode, 0);
  assert.deepStrictEqual(res.lines, [
    'PLAN_MODE_OUTPUT_FILE=/tmp/blocked-output.json',
    'PLAN_MODE_EXIT=1',
    'PLAN_MODE_OUTPUT_FILE: /tmp/blocked-output.json',
    'STATUS: 1',
  ]);
});

test('runPlanModeCheck really executes a real target script end-to-end (unmocked spawnSync)', () => {
  const dir = makeTempDir();
  const sentinel = path.join(dir, 'invoked.txt');
  const fakeShip = path.join(dir, 'fake-ship.js');
  fs.writeFileSync(
    fakeShip,
    `require('fs').writeFileSync(${JSON.stringify(sentinel)}, process.argv.slice(2).join(' '));\n` +
      `process.stdout.write('/tmp/real-output-file.json\\n');\n`
  );

  assert.strictEqual(fs.existsSync(sentinel), false);

  const res = runPlanModeCheck(
    ['node', 'plan-mode-check.js', 'some free-text $ARGUMENTS'],
    { shipScript: fakeShip }
  );

  assert.strictEqual(fs.existsSync(sentinel), true, 'ship.js must have actually run');
  assert.strictEqual(
    fs.readFileSync(sentinel, 'utf8'),
    '--output-file --plan-mode-blocked some free-text $ARGUMENTS'
  );
  assert.strictEqual(res.lines[0], 'PLAN_MODE_OUTPUT_FILE=/tmp/real-output-file.json');
});

// ---------------------------------------------------------------------------
// End-to-end CLI — resolution (the sibling target ships in-repo)
// ---------------------------------------------------------------------------

test('CLI resolves scripts/skill/ship.js relative to its own location', () => {
  const realTarget = path.join(__dirname, '..', 'skill', 'ship.js');
  assert.ok(fs.existsSync(realTarget), 'scripts/skill/ship.js must exist for this CLI to invoke');
});
