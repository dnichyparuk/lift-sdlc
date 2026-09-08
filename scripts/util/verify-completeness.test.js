'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, runVerifyCompleteness, markExecuteFailed } = require('./verify-completeness');

const SCRIPT = path.join(__dirname, 'verify-completeness.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verify-completeness-'));
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs reads --state-file and --plan-file', () => {
  const parsed = parseArgs(['node', 'verify-completeness.js', '--state-file', '/s.json', '--plan-file', '/p.md']);
  assert.strictEqual(parsed.stateFile, '/s.json');
  assert.strictEqual(parsed.planFile, '/p.md');
  assert.deepStrictEqual(parsed.errors, []);
});

test('parseArgs reports an unknown flag', () => {
  const parsed = parseArgs(['node', 'verify-completeness.js', '--bogus']);
  assert.match(parsed.errors[0], /Unknown parameter passed: --bogus/);
});

// ---------------------------------------------------------------------------
// runVerifyCompleteness — core logic with injectable deps
// ---------------------------------------------------------------------------

test('runVerifyCompleteness requires both --state-file and --plan-file', () => {
  const res = runVerifyCompleteness(['node', 'verify-completeness.js', '--state-file', '/s.json']);
  assert.strictEqual(res.exitCode, 1);
  assert.match(res.stderr, /--state-file and --plan-file are required/);
});

test('runVerifyCompleteness exits 2 when scripts/state/execute.js cannot be located', () => {
  const res = runVerifyCompleteness(
    ['node', 'verify-completeness.js', '--state-file', '/s.json', '--plan-file', '/p.md'],
    { existsFn: () => false }
  );
  assert.strictEqual(res.exitCode, 2);
  assert.match(res.stderr, /Could not locate/);
});

test('runVerifyCompleteness invokes scripts/state/execute.js verify-completeness', () => {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, error: null };
  };
  const res = runVerifyCompleteness(
    ['node', 'verify-completeness.js', '--state-file', '/s.json', '--plan-file', '/p.md'],
    { spawnFn, existsFn: () => true, executeScript: '/fake/execute.js' }
  );
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].args, ['/fake/execute.js', 'verify-completeness']);
  assert.strictEqual(res.exitCode, 0);
});

test('runVerifyCompleteness propagates a non-zero completeness exit code (e.g. 65) without throwing', () => {
  const spawnFn = () => ({ status: 65, error: null });
  const dir = makeTempDir();
  const stateFile = path.join(dir, 'state.json');
  const planFile = path.join(dir, 'plan.md');
  fs.writeFileSync(stateFile, JSON.stringify({ flags: { steps: ['execute'] }, steps: { execute: { status: 'in_progress' } } }));
  fs.writeFileSync(planFile, '### Task 1: Do the thing\n');

  const res = runVerifyCompleteness(
    ['node', 'verify-completeness.js', '--state-file', stateFile, '--plan-file', planFile],
    { spawnFn, existsFn: () => true }
  );
  assert.strictEqual(res.exitCode, 65);
});

test('runVerifyCompleteness surfaces an unexpected subprocess failure as exit 2 (no set -e/$? dance)', () => {
  const spawnFn = () => { throw new Error('spawn EACCES'); };
  const res = runVerifyCompleteness(
    ['node', 'verify-completeness.js', '--state-file', '/s.json', '--plan-file', '/p.md'],
    { spawnFn, existsFn: () => true }
  );
  assert.strictEqual(res.exitCode, 2);
  assert.match(res.stderr, /Unexpected error running verify-completeness/);
});

// ---------------------------------------------------------------------------
// markExecuteFailed — replaces todos_wrapper.sh, calls lib/ship-todos directly
// ---------------------------------------------------------------------------

test('markExecuteFailed renders the execute-failed TodoWrite payload via lib/ship-todos', () => {
  const dir = makeTempDir();
  const stateFile = path.join(dir, 'state.json');
  const planFile = path.join(dir, 'plan.md');
  fs.writeFileSync(stateFile, JSON.stringify({
    flags: { steps: ['execute'] },
    steps: { execute: { status: 'in_progress' } },
  }));
  fs.writeFileSync(planFile, '### Task 1: Do the thing\n### Task 2: Do another thing\n');

  const result = markExecuteFailed(stateFile, planFile);
  assert.ok(result);
  assert.match(result.marker, /\[task-tray\] execute: /);
  const parsed = JSON.parse(result.json);
  assert.ok(Array.isArray(parsed.todos));
  // No --current-step is passed (matches the original todos_wrapper.sh call,
  // which only ever passed --event execute --fail-step execute), so every
  // execute substep — never having been marked in_progress — surfaces as
  // "not attempted" rather than "failed" (see lib/ship-todos.js renderTodos).
  assert.ok(parsed.todos.some((t) => /not attempted/.test(t.activeForm)));
});

test('markExecuteFailed returns null and warns (non-fatal) when the state file cannot be read', () => {
  const result = markExecuteFailed('/does/not/exist.json', '/does/not/exist.md');
  assert.strictEqual(result, null);
});

// ---------------------------------------------------------------------------
// End-to-end CLI
// ---------------------------------------------------------------------------

test('CLI exits 1 when required flags are missing', () => {
  const res = run([]);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /--state-file and --plan-file are required/);
});

test('CLI exits 1 on an unknown flag', () => {
  const res = run(['--nope']);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /Unknown parameter passed/);
});
