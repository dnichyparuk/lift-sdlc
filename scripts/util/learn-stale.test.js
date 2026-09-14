'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parseArgs,
  collectGuardrailIds,
  guardrailAgeDays,
  readLearningsLog,
  findStaleGuardrails,
} = require('./learn-stale');

const SCRIPT = path.join(__dirname, 'learn-stale.js');

function makeRoot(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-stale-'));
  fs.mkdirSync(path.join(dir, '.sdlc'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.sdlc', 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

function writeLog(root, content) {
  fs.mkdirSync(path.join(root, '.sdlc', 'learnings'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sdlc', 'learnings', 'log.md'), content);
}

/** Build an injectable spawnFn that answers `git log ... -S<id> ...` with a
 * fixed introduction date per id, and fails (empty) for any other id. */
function makeGitStub(ageByCommitIso) {
  return (cmd, args) => {
    assert.equal(cmd, 'git');
    assert.equal(args[0], 'log');
    const sArg = args.find((a) => a.startsWith('-S'));
    const id = sArg ? sArg.slice(2) : null;
    const iso = ageByCommitIso[id];
    if (!iso) return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: iso + '\n', stderr: '' };
  };
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs accepts no flags', () => {
  assert.deepEqual(parseArgs(['node', 'learn-stale.js']), {});
});

// ---------------------------------------------------------------------------
// findStaleGuardrails — feature off
// ---------------------------------------------------------------------------

test('findStaleGuardrails: staleAfterCycles null is feature off, no findings', () => {
  const root = makeRoot({
    plan: { guardrails: [{ id: 'no-force-push' }] },
  });
  const spawnFn = () => {
    throw new Error('spawnFn must not be called when the feature is off');
  };

  const result = findStaleGuardrails({ spawnFn, cwd: root, staleAfterCycles: null });

  assert.deepEqual(result, { off: true, flagged: [], checked: 0 });
});

// ---------------------------------------------------------------------------
// findStaleGuardrails — the AND gate
// ---------------------------------------------------------------------------

test('findStaleGuardrails: flags a guardrail that exceeds the threshold AND has no log mention', () => {
  const root = makeRoot({
    plan: { guardrails: [{ id: 'stale-one' }] },
  });
  writeLog(root, '# learnings\nnothing relevant here\n');
  const spawnFn = makeGitStub({ 'stale-one': daysAgoIso(400) });

  const result = findStaleGuardrails({ spawnFn, cwd: root, staleAfterCycles: 90 });

  assert.equal(result.off, false);
  assert.equal(result.checked, 1);
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].id, 'stale-one');
  assert.equal(result.flagged[0].mentionedInLog, false);
  assert.ok(result.flagged[0].ageDays >= 400);
});

test('findStaleGuardrails: does NOT flag a guardrail within the threshold', () => {
  const root = makeRoot({
    plan: { guardrails: [{ id: 'fresh-one' }] },
  });
  const spawnFn = makeGitStub({ 'fresh-one': daysAgoIso(5) });

  const result = findStaleGuardrails({ spawnFn, cwd: root, staleAfterCycles: 90 });

  assert.equal(result.checked, 1);
  assert.deepEqual(result.flagged, []);
});

test('findStaleGuardrails: does NOT flag an old guardrail that IS mentioned in the log', () => {
  const root = makeRoot({
    plan: { guardrails: [{ id: 'old-but-logged' }] },
  });
  writeLog(root, '# learnings\nold-but-logged came up again in review\n');
  const spawnFn = makeGitStub({ 'old-but-logged': daysAgoIso(400) });

  const result = findStaleGuardrails({ spawnFn, cwd: root, staleAfterCycles: 90 });

  assert.equal(result.checked, 1);
  assert.deepEqual(result.flagged, []);
});

test('findStaleGuardrails: exceeds is strict — exactly at the threshold does not flag', () => {
  const root = makeRoot({
    plan: { guardrails: [{ id: 'boundary' }] },
  });
  const spawnFn = makeGitStub({ boundary: daysAgoIso(90) });

  const result = findStaleGuardrails({ spawnFn, cwd: root, staleAfterCycles: 90 });

  assert.deepEqual(result.flagged, []);
});

// ---------------------------------------------------------------------------
// findStaleGuardrails — guardrail collection across sections
// ---------------------------------------------------------------------------

test('findStaleGuardrails: collects and dedupes guardrail ids across plan and execute sections', () => {
  const root = makeRoot({
    plan:    { guardrails: [{ id: 'shared-id' }, { id: 'plan-only' }] },
    execute: { guardrails: [{ id: 'shared-id' }, 'execute-string-id'] },
  });
  const spawnFn = makeGitStub({
    'shared-id': daysAgoIso(5),
    'plan-only': daysAgoIso(5),
    'execute-string-id': daysAgoIso(5),
  });

  const result = findStaleGuardrails({ spawnFn, cwd: root, staleAfterCycles: 90 });

  assert.equal(result.checked, 3);
});

test('findStaleGuardrails: no guardrails configured -> checked 0, no findings', () => {
  const root = makeRoot({});
  const spawnFn = () => {
    throw new Error('spawnFn must not be called when there are no guardrails');
  };

  const result = findStaleGuardrails({ spawnFn, cwd: root, staleAfterCycles: 90 });

  assert.deepEqual(result, { off: false, flagged: [], checked: 0 });
});

// ---------------------------------------------------------------------------
// findStaleGuardrails — advisory only (never writes)
// ---------------------------------------------------------------------------

test('findStaleGuardrails: never mutates .sdlc/config.json or the learnings log', () => {
  const config = { plan: { guardrails: [{ id: 'stale-one' }] } };
  const root = makeRoot(config);
  writeLog(root, 'original log content\n');
  const configPath = path.join(root, '.sdlc', 'config.json');
  const logPath = path.join(root, '.sdlc', 'learnings', 'log.md');
  const beforeConfig = fs.readFileSync(configPath, 'utf8');
  const beforeLog = fs.readFileSync(logPath, 'utf8');
  const spawnFn = makeGitStub({ 'stale-one': daysAgoIso(400) });

  findStaleGuardrails({ spawnFn, cwd: root, staleAfterCycles: 90 });

  assert.equal(fs.readFileSync(configPath, 'utf8'), beforeConfig);
  assert.equal(fs.readFileSync(logPath, 'utf8'), beforeLog);
});

// ---------------------------------------------------------------------------
// collectGuardrailIds
// ---------------------------------------------------------------------------

test('collectGuardrailIds: injectable readSectionFn, no real .sdlc/config.json required', () => {
  const readSectionFn = (cwd, section) => {
    if (section === 'plan') return { guardrails: [{ id: 'a' }, { id: 'b' }] };
    if (section === 'execute') return { guardrails: [{ id: 'b' }, { id: 'c' }] };
    return null;
  };

  const ids = collectGuardrailIds('/repo', { readSectionFn });

  assert.deepEqual(ids.sort(), ['a', 'b', 'c']);
});

test('collectGuardrailIds: tolerates missing sections and non-array guardrails', () => {
  const readSectionFn = () => null;
  assert.deepEqual(collectGuardrailIds('/repo', { readSectionFn }), []);
});

// ---------------------------------------------------------------------------
// guardrailAgeDays
// ---------------------------------------------------------------------------

test('guardrailAgeDays: computes age in days from the oldest matching commit date', () => {
  const spawnFn = makeGitStub({ 'my-id': daysAgoIso(10) });
  const age = guardrailAgeDays(spawnFn, '/repo', 'my-id');
  assert.ok(age === 9 || age === 10, `expected ~10, got ${age}`);
});

test('guardrailAgeDays: resolves to 0 when git finds no matching commit', () => {
  const spawnFn = () => ({ status: 0, stdout: '', stderr: '' });
  assert.equal(guardrailAgeDays(spawnFn, '/repo', 'missing-id'), 0);
});

test('guardrailAgeDays: resolves to 0 when the git command fails (non-zero status)', () => {
  const spawnFn = () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' });
  assert.equal(guardrailAgeDays(spawnFn, '/repo', 'any-id'), 0);
});

test('guardrailAgeDays: resolves to 0 on an unparseable date', () => {
  const spawnFn = () => ({ status: 0, stdout: 'not-a-date\n', stderr: '' });
  assert.equal(guardrailAgeDays(spawnFn, '/repo', 'any-id'), 0);
});

// ---------------------------------------------------------------------------
// readLearningsLog
// ---------------------------------------------------------------------------

test('readLearningsLog: returns file content when present', () => {
  const root = makeRoot({});
  writeLog(root, 'hello world\n');
  assert.equal(readLearningsLog(root), 'hello world\n');
});

test('readLearningsLog: returns empty string when the log is absent (common per the ADR caveat)', () => {
  const root = makeRoot({});
  assert.equal(readLearningsLog(root), '');
});

// ---------------------------------------------------------------------------
// CLI smoke test (off-path only — no real git repo required)
// ---------------------------------------------------------------------------

test('CLI: prints {off:true, flagged:[], checked:0} and exits 0 when learn.staleAfterCycles is null', () => {
  const root = makeRoot({ learn: { staleAfterCycles: null } });

  const result = spawnSync('node', [SCRIPT], { cwd: root, encoding: 'utf8' });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout.trim());
  assert.deepEqual(parsed, { off: true, flagged: [], checked: 0 });
});

test('CLI: treats a missing learn section as feature off', () => {
  const root = makeRoot({});

  const result = spawnSync('node', [SCRIPT], { cwd: root, encoding: 'utf8' });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout.trim());
  assert.deepEqual(parsed, { off: true, flagged: [], checked: 0 });
});
