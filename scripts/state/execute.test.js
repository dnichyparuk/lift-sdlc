'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'execute.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a temp git repo with three commits:
 *   A (init, on `main`) -> B (on `main`, current HEAD)
 *   A -> C (on `other`, a divergent branch)
 * HEAD is left checked out at B on `main`.
 * Returns { dir, shaA, shaB, shaC }.
 */
function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-state-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });

  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'A'], { cwd: dir, stdio: 'ignore' });
  const shaA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'B'], { cwd: dir, stdio: 'ignore' });
  const shaB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  execFileSync('git', ['branch', 'other', shaA], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['checkout', '-q', 'other'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'C'], { cwd: dir, stdio: 'ignore' });
  const shaC = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  // Leave HEAD at B on main, as a resumed execution would find it.
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir, stdio: 'ignore' });

  return { dir, shaA, shaB, shaC };
}

function stateDirFor(dir) {
  return path.join(dir, '.sdlc', 'execution');
}

function run(args, cwd) {
  // Bounded timeout: several tests below exercise the --help fast path,
  // which must exit before ever touching stdin — this guards against any
  // future regression that makes the CLI block waiting on input.
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, SDLC_STATE_DIR_OVERRIDE: stateDirFor(cwd) },
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch (_) { /* left null */ }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

/** Write an execute state file directly (bypassing the CLI) with the given waves. */
function writeExecuteState(dir, branch, waves) {
  const slug = branch.replace(/[^a-zA-Z0-9-]/g, '-');
  const stateDir = stateDirFor(dir);
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, `execute-${slug}-20260101T000000Z.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    skill: 'execute-plan-sdlc',
    startedAt: '2026-01-01T00:00:00.000Z',
    branch,
    quality: 'balanced',
    totalTasks: 1,
    plannedTaskIds: ['1'],
    waves,
    context: {},
  }, null, 2));
  return filePath;
}

// ---------------------------------------------------------------------------
// detect-resume
// ---------------------------------------------------------------------------

test('detect-resume: no state file for the branch -> found:false, waveShaStatus:[]', () => {
  const { dir } = makeTempRepo();
  const res = run(['detect-resume', '--branch', 'feat-nothing-here'], dir);

  assert.strictEqual(res.status, 0);
  assert.ok(res.json);
  assert.strictEqual(res.json.found, false);
  assert.strictEqual(res.json.stateFile, null);
  assert.strictEqual(res.json.fullPath, null);
  assert.deepStrictEqual(res.json.waveShaStatus, []);
});

test('detect-resume: committedSha null/absent -> reachable:null (not applicable)', () => {
  const { dir } = makeTempRepo();
  writeExecuteState(dir, 'feat-notapplicable', [
    { number: 1, status: 'completed', tasks: [] }, // no committedSha field at all
    { number: 2, status: 'completed', committedSha: null, tasks: [] },
  ]);

  const res = run(['detect-resume', '--branch', 'feat-notapplicable'], dir);

  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.json.found, true);
  assert.deepStrictEqual(res.json.waveShaStatus, [
    { wave: 1, committedSha: null, reachable: null },
    { wave: 2, committedSha: null, reachable: null },
  ]);
});

test('detect-resume: committedSha is an ancestor of HEAD -> reachable:true', () => {
  const { dir, shaA } = makeTempRepo();
  writeExecuteState(dir, 'feat-reachable', [
    { number: 1, status: 'completed', committedSha: shaA, tasks: [] },
  ]);

  const res = run(['detect-resume', '--branch', 'feat-reachable'], dir);

  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.json.found, true);
  assert.deepStrictEqual(res.json.waveShaStatus, [
    { wave: 1, committedSha: shaA, reachable: true },
  ]);
});

test('detect-resume: committedSha is NOT an ancestor of HEAD -> reachable:false (diverged)', () => {
  const { dir, shaC } = makeTempRepo();
  writeExecuteState(dir, 'feat-diverged', [
    { number: 1, status: 'completed', committedSha: shaC, tasks: [] },
  ]);

  const res = run(['detect-resume', '--branch', 'feat-diverged'], dir);

  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.json.found, true);
  assert.deepStrictEqual(res.json.waveShaStatus, [
    { wave: 1, committedSha: shaC, reachable: false },
  ]);
});

test('detect-resume: mixed waves classify independently in one call', () => {
  const { dir, shaA, shaC } = makeTempRepo();
  writeExecuteState(dir, 'feat-mixed', [
    { number: 1, status: 'completed', committedSha: shaA, tasks: [] },
    { number: 2, status: 'completed', committedSha: shaC, tasks: [] },
    { number: 3, status: 'completed', tasks: [] },
  ]);

  const res = run(['detect-resume', '--branch', 'feat-mixed'], dir);

  assert.strictEqual(res.status, 0);
  assert.deepStrictEqual(res.json.waveShaStatus, [
    { wave: 1, committedSha: shaA, reachable: true },
    { wave: 2, committedSha: shaC, reachable: false },
    { wave: 3, committedSha: null, reachable: null },
  ]);
});

test('detect-resume: passes through stateFile/fullPath/found/fresh/nextPendingStep from detectResumeState verbatim', () => {
  const { dir } = makeTempRepo();
  const filePath = writeExecuteState(dir, 'feat-shape', [
    { number: 1, status: 'completed', tasks: [] },
  ]);

  const res = run(['detect-resume', '--branch', 'feat-shape'], dir);

  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.json.found, true);
  assert.strictEqual(res.json.fresh, true);
  assert.strictEqual(res.json.fullPath, filePath);
  assert.match(res.json.stateFile, /execute-feat-shape-20260101T000000Z\.json$/);
  // No `steps[]` array in execute state (that's a ship-state concept) -> null.
  assert.strictEqual(res.json.nextPendingStep, null);
});

test('detect-resume: unknown subcommand list still rejects bogus subcommands', () => {
  const { dir } = makeTempRepo();
  const res = run(['not-a-real-subcommand'], dir);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /unknown subcommand/);
  assert.match(res.stderr, /detect-resume/);
});

// ---------------------------------------------------------------------------
// Top-level --help / -h / help / no-args
// ---------------------------------------------------------------------------

test('--help prints Usage to stdout and exits 0', () => {
  const { dir } = makeTempRepo();
  const res = run(['--help'], dir);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /^Usage:/);
  assert.strictEqual(res.stderr, '');
});

test('-h prints Usage to stdout and exits 0', () => {
  const { dir } = makeTempRepo();
  const res = run(['-h'], dir);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /^Usage:/);
});

test('help prints Usage to stdout and exits 0', () => {
  const { dir } = makeTempRepo();
  const res = run(['help'], dir);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /^Usage:/);
});

test('no arguments prints Usage to stdout and exits 0', () => {
  const { dir } = makeTempRepo();
  const res = run([], dir);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /^Usage:/);
});

test('<subcommand> --help prints usage and exits 0 before required-flag validation', () => {
  const { dir } = makeTempRepo();
  // task-done normally requires --wave/--task; omitting them here would
  // exit 2 if --help did not short-circuit first.
  const res = run(['task-done', '--help'], dir);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /^Usage:/);
  assert.strictEqual(res.stderr, '');
});

// ---------------------------------------------------------------------------
// read / show / status aliases
// ---------------------------------------------------------------------------

test('show behaves exactly like read', () => {
  const { dir } = makeTempRepo();
  writeExecuteState(dir, 'feat-show', [{ number: 1, status: 'completed', tasks: [] }]);
  const readRes = run(['read', '--branch', 'feat-show'], dir);
  const showRes = run(['show', '--branch', 'feat-show'], dir);
  assert.strictEqual(showRes.status, 0);
  assert.strictEqual(showRes.stdout, readRes.stdout);
});

test('status behaves exactly like read', () => {
  const { dir } = makeTempRepo();
  writeExecuteState(dir, 'feat-status', [{ number: 1, status: 'completed', tasks: [] }]);
  const readRes = run(['read', '--branch', 'feat-status'], dir);
  const statusRes = run(['status', '--branch', 'feat-status'], dir);
  assert.strictEqual(statusRes.status, 0);
  assert.strictEqual(statusRes.stdout, readRes.stdout);
});

// ---------------------------------------------------------------------------
// Strict per-subcommand flag validation
// ---------------------------------------------------------------------------

test('unknown flag for a subcommand exits 2 and lists accepted flags', () => {
  const { dir } = makeTempRepo();
  const res = run(['task-done', '--wave', '1', '--task', '1', '--files', '[]'], dir);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /unknown flag "--files" for task-done/);
  assert.match(res.stderr, /--files-changed/);
});

test('a flag valid on another subcommand is still rejected as unknown here', () => {
  const { dir } = makeTempRepo();
  const res = run(['wave-start', '--wave', '1', '--quality', 'balanced'], dir);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /unknown flag "--quality" for wave-start/);
});

test('--branch and --state-file remain accepted on every subcommand', () => {
  const { dir } = makeTempRepo();
  // read has an empty SUBCOMMAND_FLAGS entry — only globals apply.
  const res = run(['read', '--branch', 'feat-nothing-here', '--state-file', path.join(dir, 'nope.json')], dir);
  // Doesn't matter whether the state resolves; the flags themselves must
  // parse without an "unknown flag" error.
  assert.doesNotMatch(res.stderr, /unknown flag/);
});

test('value flag as the last token exits 2 with "requires a value"', () => {
  const { dir } = makeTempRepo();
  const res = run(['wave-done', '--wave'], dir);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /--wave requires a value/);
});

test('--sha "" is consumed as an explicit empty value, not treated as missing', () => {
  const { dir } = makeTempRepo();
  writeExecuteState(dir, 'feat-empty-sha', [{ number: 1, status: 'completed', tasks: [] }]);
  const res = run(['wave-committed', '--branch', 'feat-empty-sha', '--wave', '1', '--sha', ''], dir);
  assert.strictEqual(res.status, 0, res.stderr);

  const stateDir = stateDirFor(dir);
  const file = fs.readdirSync(stateDir).find(f => f.includes('feat-empty-sha'));
  const data = JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8'));
  assert.strictEqual(data.waves[0].committedSha, null);
});

// ---------------------------------------------------------------------------
// --preset hard rejection (#190) — applies to every subcommand now
// ---------------------------------------------------------------------------

test('--preset on init still exits 2 with the "no longer accepted" message', () => {
  const { dir } = makeTempRepo();
  const res = run(['init', '--branch', 'feat-x', '--preset', 'full', '--quality', 'full', '--total-tasks', '1'], dir);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /--preset is no longer accepted/);
  assert.match(res.stderr, /#190/);
});

test('--preset on wave-start (a non-init subcommand) also exits 2 with the rejection message', () => {
  const { dir } = makeTempRepo();
  const res = run(['wave-start', '--preset', 'x', '--wave', '1'], dir);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /--preset is no longer accepted/);
});

// ---------------------------------------------------------------------------
// init: derive plannedTaskIds from --plan-path (F-execute-subcommand-cli-hardening-5)
// ---------------------------------------------------------------------------

function writePlanFile(dir, contents) {
  const p = path.join(dir, 'plan.md');
  fs.writeFileSync(p, contents);
  return p;
}

function readInitializedState(dir, branch) {
  const stateDir = stateDirFor(dir);
  const file = fs.readdirSync(stateDir).find(f => f.includes(branch));
  return JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8'));
}

test('init --plan-path derives plannedTaskIds from "### Task N:" headings when --planned-task-ids is absent', () => {
  const { dir } = makeTempRepo();
  const planPath = writePlanFile(dir, '### Task 1: First\n\nbody\n\n### Task 2: Second\n\nbody\n');

  const res = run(['init', '--branch', 'feat-derive', '--quality', 'balanced', '--total-tasks', '2', '--plan-path', planPath], dir);
  assert.strictEqual(res.status, 0, res.stderr);

  const data = readInitializedState(dir, 'feat-derive');
  assert.deepStrictEqual(data.plannedTaskIds, ['1', '2']);
  assert.strictEqual(res.stderr, '');
});

test('init --planned-task-ids wins over --plan-path derivation', () => {
  const { dir } = makeTempRepo();
  const planPath = writePlanFile(dir, '### Task 1: First\n\n### Task 2: Second\n');

  const res = run(['init', '--branch', 'feat-explicit-wins', '--quality', 'balanced', '--total-tasks', '1',
    '--planned-task-ids', '["7"]', '--plan-path', planPath], dir);
  assert.strictEqual(res.status, 0, res.stderr);

  const data = readInitializedState(dir, 'feat-explicit-wins');
  assert.deepStrictEqual(data.plannedTaskIds, ['7']);
});

test('init with neither --plan-path nor --planned-task-ids -> plannedTaskIds null plus stderr warning, exit 0', () => {
  const { dir } = makeTempRepo();
  const res = run(['init', '--branch', 'feat-no-ids', '--quality', 'balanced', '--total-tasks', '1'], dir);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stderr, /Warning: plannedTaskIds not set — verify-completeness will fail; pass --planned-task-ids or --plan-path/);

  const data = readInitializedState(dir, 'feat-no-ids');
  assert.strictEqual(data.plannedTaskIds, null);
});

test('init --plan-path pointing at an unreadable file -> plannedTaskIds null plus the same warning, exit 0', () => {
  const { dir } = makeTempRepo();
  const missingPath = path.join(dir, 'does-not-exist.md');

  const res = run(['init', '--branch', 'feat-unreadable-plan', '--quality', 'balanced', '--total-tasks', '1',
    '--plan-path', missingPath], dir);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stderr, /Warning: plannedTaskIds not set/);

  const data = readInitializedState(dir, 'feat-unreadable-plan');
  assert.strictEqual(data.plannedTaskIds, null);
});

// ---------------------------------------------------------------------------
// wave-start: seed wave.tasks from --tasks-json (F-git-stderr-leak-and-wave-start-task-seeding-2)
// ---------------------------------------------------------------------------

test('wave-start --tasks-json seeds wave.tasks with in_progress entries', () => {
  const { dir } = makeTempRepo();
  writeExecuteState(dir, 'feat-seed', []);

  const tasksJson = JSON.stringify([
    { id: '3', name: 'X', complexity: 'Standard', risk: 'Low' },
    { id: '4' },
  ]);
  const res = run(['wave-start', '--branch', 'feat-seed', '--wave', '2', '--tasks-json', tasksJson], dir);
  assert.strictEqual(res.status, 0, res.stderr);

  const data = readInitializedState(dir, 'feat-seed');
  const wave = data.waves.find(w => w.number === 2);
  assert.ok(wave, 'wave 2 should exist');
  assert.deepStrictEqual(wave.tasks, [
    { id: '3', name: 'X', complexity: 'Standard', risk: 'Low', status: 'in_progress', filesChanged: [] },
    { id: '4', name: '', complexity: '', risk: '', status: 'in_progress', filesChanged: [] },
  ]);
});

test('re-running wave-start for the same wave does not duplicate seeded entries', () => {
  const { dir } = makeTempRepo();
  writeExecuteState(dir, 'feat-seed-twice', []);

  const tasksJson = JSON.stringify([{ id: '3', name: 'X', complexity: 'Standard', risk: 'Low' }]);
  run(['wave-start', '--branch', 'feat-seed-twice', '--wave', '2', '--tasks-json', tasksJson], dir);
  const res = run(['wave-start', '--branch', 'feat-seed-twice', '--wave', '2', '--tasks-json', tasksJson], dir);
  assert.strictEqual(res.status, 0, res.stderr);

  const data = readInitializedState(dir, 'feat-seed-twice');
  const wave = data.waves.find(w => w.number === 2);
  assert.strictEqual(wave.tasks.length, 1);
  assert.strictEqual(wave.tasks[0].id, '3');
});

test('task-done updates a seeded wave.tasks entry in place rather than duplicating it', () => {
  const { dir } = makeTempRepo();
  writeExecuteState(dir, 'feat-seed-done', []);

  const tasksJson = JSON.stringify([{ id: '3', name: 'X', complexity: 'Standard', risk: 'Low' }]);
  run(['wave-start', '--branch', 'feat-seed-done', '--wave', '2', '--tasks-json', tasksJson], dir);

  const res = run(['task-done', '--branch', 'feat-seed-done', '--wave', '2', '--task', '3',
    '--name', 'X', '--complexity', 'Standard', '--risk', 'Low', '--files-changed', '["a.js"]'], dir);
  assert.strictEqual(res.status, 0, res.stderr);

  const data = readInitializedState(dir, 'feat-seed-done');
  const wave = data.waves.find(w => w.number === 2);
  assert.strictEqual(wave.tasks.length, 1);
  assert.strictEqual(wave.tasks[0].id, '3');
  assert.strictEqual(wave.tasks[0].status, 'completed');
  assert.deepStrictEqual(wave.tasks[0].filesChanged, ['a.js']);
});

test('verify-completeness on a state produced by the derived plannedTaskIds path exits 0 once all tasks are done', () => {
  const { dir } = makeTempRepo();
  const planPath = writePlanFile(dir, '### Task 1: First\n\n### Task 2: Second\n');
  run(['init', '--branch', 'feat-derived-verify', '--quality', 'balanced', '--total-tasks', '2', '--plan-path', planPath], dir);

  run(['wave-start', '--branch', 'feat-derived-verify', '--wave', '1',
    '--tasks-json', JSON.stringify([{ id: '1', name: 'First' }, { id: '2', name: 'Second' }])], dir);
  run(['task-done', '--branch', 'feat-derived-verify', '--wave', '1', '--task', '1', '--files-changed', '[]'], dir);
  run(['task-done', '--branch', 'feat-derived-verify', '--wave', '1', '--task', '2', '--files-changed', '[]'], dir);

  const res = run(['verify-completeness', '--branch', 'feat-derived-verify'], dir);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.json.ok, true);
});
