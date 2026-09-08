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
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
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
