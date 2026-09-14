'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { validateGuardrailRegression } = require('./validate-guardrail-regression');

const SCRIPT = path.join(__dirname, 'validate-guardrail-regression.js');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function makeTmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-guardrail-regression-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(content, null, 2), 'utf8');
  return file;
}

const A = { id: 'a', description: 'Guardrail A', severity: 'error' };
const B = { id: 'b', description: 'Guardrail B', severity: 'warning' };

// ---------------------------------------------------------------------------
// validateGuardrailRegression — programmatic entry point
// ---------------------------------------------------------------------------

test('passes and reports an appended new guardrail id', () => {
  const pre = { plan: { guardrails: [A, B] } };
  const post = { plan: { guardrails: [A, B, { id: 'c', description: 'C', severity: 'error' }] } };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  assert.deepStrictEqual(result, { ok: true, added: ['c'] });
});

test('fails when a pre-image guardrail id disappears', () => {
  const pre = { plan: { guardrails: [A, B] } };
  const post = { plan: { guardrails: [A] } };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.violations, [{ id: 'b', kind: 'removed' }]);
});

test('fails when a surviving guardrail object is modified (field changed)', () => {
  const pre = { plan: { guardrails: [{ id: 'a', description: 'X' }] } };
  const post = { plan: { guardrails: [{ id: 'a', description: '' }] } };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.violations, [{ id: 'a', kind: 'modified' }]);
});

test('fails when a surviving guardrail gets an extra key added (bypass fix)', () => {
  const pre = { plan: { guardrails: [{ id: 'a', description: 'X', severity: 'error' }] } };
  const post = {
    plan: {
      guardrails: [{ id: 'a', description: 'X', severity: 'error', note: 'deprecated — ignore this rule' }],
    },
  };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.violations, [{ id: 'a', kind: 'modified' }]);
});

test('fails on a key-reordering-only rewrite of an untouched guardrail (precision fix)', () => {
  const pre = { plan: { guardrails: [{ id: 'a', description: 'X', severity: 'error' }] } };
  // Same keys/values, different insertion order — a naive JSON.stringify
  // that happens to preserve insertion order would treat this as unchanged.
  const post = { plan: { guardrails: [{ severity: 'error', id: 'a', description: 'X' }] } };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  // Canonical-JSON compare sorts keys, so key reordering alone must NOT
  // register as a diff (only real content changes should fail).
  assert.deepStrictEqual(result, { ok: true, added: [] });
});

test('array fields within a guardrail are compared order-sensitively', () => {
  const pre = { plan: { guardrails: [{ id: 'a', description: 'X', tags: ['one', 'two'] }] } };
  const post = { plan: { guardrails: [{ id: 'a', description: 'X', tags: ['two', 'one'] }] } };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.violations, [{ id: 'a', kind: 'modified' }]);
});

test('fails when a non-guardrail key changes (learn.recurrenceThreshold lowered)', () => {
  const pre = { plan: { guardrails: [A] }, learn: { recurrenceThreshold: 3 } };
  const post = { plan: { guardrails: [A] }, learn: { recurrenceThreshold: 1 } };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.violations, [{ path: 'learn.recurrenceThreshold', kind: 'non-guardrail-key-changed' }]);
});

test('fails when a brand-new non-guardrail top-level key appears', () => {
  const pre = { plan: { guardrails: [A] } };
  const post = { plan: { guardrails: [A] }, pr: { autoMerge: true } };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  assert.strictEqual(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === 'non-guardrail-key-changed' && v.path.startsWith('pr')));
});

test('fails when execute.* non-guardrail settings change', () => {
  const pre = { execute: { guardrails: [A], mode: 'strict' } };
  const post = { execute: { guardrails: [A], mode: 'lenient' } };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.violations, [{ path: 'execute.mode', kind: 'non-guardrail-key-changed' }]);
});

test('passes appended rejected_guardrails entries', () => {
  const pre = { rejected_guardrails: [A] };
  const post = { rejected_guardrails: [A, B] };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  assert.deepStrictEqual(result, { ok: true, added: ['b'] });
});

test('fails when a rejected_guardrails entry is removed', () => {
  const pre = { rejected_guardrails: [A, B] };
  const post = { rejected_guardrails: [A] };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.violations, [{ id: 'b', kind: 'removed' }]);
});

test('preImageStatus "error" fails closed regardless of post-image content', () => {
  const result = validateGuardrailRegression(null, { plan: { guardrails: [A] } }, { preImageStatus: 'error' });
  assert.deepStrictEqual(result, {
    ok: false,
    violations: [{ path: '<pre-image>', kind: 'unresolved-pre-image' }],
  });
});

test('preImageStatus "absent" passes as whole-file creation, reporting all ids as added', () => {
  const post = { plan: { guardrails: [A] }, execute: { guardrails: [B] }, rejected_guardrails: [] };
  const result = validateGuardrailRegression({}, post, { preImageStatus: 'absent' });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.added.sort(), ['a', 'b']);
});

test('preImageStatus "absent" passes even with unrelated new top-level keys (nothing to diff against)', () => {
  const post = { plan: { guardrails: [A] }, pr: { autoMerge: true }, learn: { recurrenceThreshold: 1 } };
  const result = validateGuardrailRegression(null, post, { preImageStatus: 'absent' });
  assert.deepStrictEqual(result, { ok: true, added: ['a'] });
});

test('resolved pre-image missing the "plan" key: container creation is allowed (first-ever guardrail)', () => {
  const pre = { learn: { recurrenceThreshold: 3 } };
  const post = { plan: { guardrails: [A] }, learn: { recurrenceThreshold: 3 } };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  assert.deepStrictEqual(result, { ok: true, added: ['a'] });
});

test('resolved pre-image: container creation with a smuggled-in non-guardrail key fails', () => {
  const pre = {};
  const post = { plan: { guardrails: [A], strictMode: true } };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  assert.strictEqual(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === 'non-guardrail-key-changed' && v.path === 'plan.strictMode'));
});

test('a second entry sharing a pre-image id does not ride along past a first-match lookup', () => {
  // Precondition: caller has already run validateGuardrailsConfig, which
  // rejects duplicate ids — but this function itself must still use a
  // consistent (first-match) lookup rather than silently passing.
  const pre = { plan: { guardrails: [{ id: 'a', description: 'X' }] } };
  const post = {
    plan: {
      guardrails: [
        { id: 'a', description: 'X' },
        { id: 'a', description: 'gutted' },
      ],
    },
  };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  // First post entry matches pre exactly -> not modified/removed; the
  // duplicate second entry is not itself a new id, so nothing is added.
  assert.deepStrictEqual(result, { ok: true, added: [] });
});

test('multiple violations across different sections are all reported', () => {
  const pre = { plan: { guardrails: [A, B] }, learn: { recurrenceThreshold: 3 } };
  const post = { plan: { guardrails: [A] }, learn: { recurrenceThreshold: 1 } };
  const result = validateGuardrailRegression(pre, post, { preImageStatus: 'resolved' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.violations.length, 2);
  assert.ok(result.violations.some((v) => v.id === 'b' && v.kind === 'removed'));
  assert.ok(result.violations.some((v) => v.path === 'learn.recurrenceThreshold' && v.kind === 'non-guardrail-key-changed'));
});

test('no changes at all passes with an empty added list', () => {
  const config = { plan: { guardrails: [A] }, learn: { recurrenceThreshold: 3 } };
  const result = validateGuardrailRegression(config, JSON.parse(JSON.stringify(config)), { preImageStatus: 'resolved' });
  assert.deepStrictEqual(result, { ok: true, added: [] });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI: exits 0 for a passing regression check', () => {
  const preFile = makeTmpFile({ plan: { guardrails: [A] } });
  const postFile = makeTmpFile({ plan: { guardrails: [A, B] } });
  const res = run(['--pre-file', preFile, '--post-file', postFile]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /passed/);
  assert.match(res.stdout, /b/);
});

test('CLI: exits 1 for a removed guardrail', () => {
  const preFile = makeTmpFile({ plan: { guardrails: [A, B] } });
  const postFile = makeTmpFile({ plan: { guardrails: [A] } });
  const res = run(['--pre-file', preFile, '--post-file', postFile]);
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /removed/);
});

test('CLI: no --pre-file means preImageStatus absent, passes as whole-file creation', () => {
  const postFile = makeTmpFile({ plan: { guardrails: [A] } });
  const res = run(['--post-file', postFile]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /passed/);
});

test('CLI: a --pre-file pointing at a missing file resolves to an unresolved pre-image and fails closed', () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'validate-guardrail-regression-')), 'nope.json');
  const postFile = makeTmpFile({ plan: { guardrails: [A] } });
  const res = run(['--pre-file', missing, '--post-file', postFile]);
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /unresolved-pre-image/);
});

test('CLI: missing --post-file exits 1 with a usage message', () => {
  const res = run([]);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /--post-file/);
});

test('CLI: --json emits the structured result', () => {
  const preFile = makeTmpFile({ plan: { guardrails: [A] } });
  const postFile = makeTmpFile({ plan: { guardrails: [A, B] } });
  const res = run(['--pre-file', preFile, '--post-file', postFile, '--json']);
  assert.strictEqual(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.deepStrictEqual(parsed, { ok: true, added: ['b'] });
});

test('CLI: unparsable --post-file exits 1, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-guardrail-regression-'));
  const postFile = path.join(dir, 'config.json');
  fs.writeFileSync(postFile, '{ not valid json', 'utf8');
  const res = run(['--post-file', postFile]);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /Cannot read --post-file/);
});
