'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  parseVerifySummary,
  VALID_VERIFICATION_STATUSES,
  VALID_SUMMARY_STATUSES,
  MAX_EVIDENCE,
  MAX_RIPPLE,
  MAX_REASONING_CHARS,
} = require('./verify-summary');

function findingJson(overrides = {}) {
  return {
    id: 'PRRT_kwDOA1',
    verificationStatus: 'confirmed',
    evidence: ['scripts/skill/received-review.js:263-285'],
    rippleEffects: [],
    reasoning: 'Claim holds.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// exported bounds/enums
// ---------------------------------------------------------------------------

test('exports the bounded enums and limits', () => {
  assert.ok(VALID_VERIFICATION_STATUSES.has('confirmed'));
  assert.ok(VALID_VERIFICATION_STATUSES.has('confirmed-incomplete'));
  assert.ok(VALID_VERIFICATION_STATUSES.has('incorrect'));
  assert.ok(VALID_VERIFICATION_STATUSES.has('partially-correct'));
  assert.ok(VALID_VERIFICATION_STATUSES.has('cannot-verify'));
  assert.equal(VALID_VERIFICATION_STATUSES.size, 5);

  assert.ok(VALID_SUMMARY_STATUSES.has('completed'));
  assert.ok(VALID_SUMMARY_STATUSES.has('partial'));
  assert.ok(VALID_SUMMARY_STATUSES.has('failed'));
  assert.equal(VALID_SUMMARY_STATUSES.size, 3);

  assert.equal(MAX_EVIDENCE, 5);
  assert.equal(MAX_RIPPLE, 3);
  assert.equal(MAX_REASONING_CHARS, 240);
});

// ---------------------------------------------------------------------------
// parseVerifySummary — happy path
// ---------------------------------------------------------------------------

test('parseVerifySummary: valid token with all dispatched IDs returned', () => {
  const payload = {
    status: 'completed',
    reportFile: '/tmp/received-review-manifest-1a2b3c4d.verification.md',
    findings: [findingJson()],
  };
  const text = `VERIFY_SUMMARY: ${JSON.stringify(payload)}`;

  const result = parseVerifySummary(text, ['PRRT_kwDOA1']);

  assert.equal(result.tokenFound, true);
  assert.equal(result.schemaOk, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.missingIds, []);
  assert.deepEqual(result.extraIds, []);
  assert.deepEqual(result.returned, ['PRRT_kwDOA1']);
  assert.deepEqual(result.parsed, payload);
});

// ---------------------------------------------------------------------------
// missing-ID overflow detection
// ---------------------------------------------------------------------------

test('parseVerifySummary: a dispatched ID absent from findings[] is reported as missing and forces schemaOk false', () => {
  const payload = {
    status: 'partial',
    reportFile: '/tmp/report.md',
    findings: [findingJson({ id: 'PRRT_kwDOA1' })],
  };
  const text = `VERIFY_SUMMARY: ${JSON.stringify(payload)}`;

  const result = parseVerifySummary(text, ['PRRT_kwDOA1', 'PRRT_kwDOA2']);

  assert.equal(result.schemaOk, false);
  assert.deepEqual(result.missingIds, ['PRRT_kwDOA2']);
  assert.ok(result.violations.some(v => /CONTEXT_OVERFLOW/.test(v)));
});

test('parseVerifySummary: extra finding IDs not in dispatched set are reported', () => {
  const payload = {
    status: 'completed',
    reportFile: '/tmp/report.md',
    findings: [findingJson({ id: 'PRRT_kwDOA1' }), findingJson({ id: 'PRRT_kwDOA9' })],
  };
  const text = `VERIFY_SUMMARY: ${JSON.stringify(payload)}`;

  const result = parseVerifySummary(text, ['PRRT_kwDOA1']);

  assert.equal(result.schemaOk, false);
  assert.deepEqual(result.extraIds, ['PRRT_kwDOA9']);
  assert.ok(result.violations.some(v => /extra finding IDs in VERIFY_SUMMARY not in dispatched set/.test(v)));
});

test('parseVerifySummary: thread IDs are compared verbatim, no leading-letter normalization', () => {
  // A dispatched ID that merely resembles a wave-summary task ID with a
  // leading "T" must NOT be treated as equal to a differently-cased/prefixed
  // returned ID — no normalizeTaskId-style stripping is applied here.
  const payload = {
    status: 'completed',
    reportFile: '/tmp/report.md',
    findings: [findingJson({ id: 'T1' })],
  };
  const text = `VERIFY_SUMMARY: ${JSON.stringify(payload)}`;

  const result = parseVerifySummary(text, ['1']);

  // "1" (dispatched) vs "T1" (returned) are distinct strings: "1" is missing
  // and "T1" is extra — proving no normalization collapses them.
  assert.deepEqual(result.missingIds, ['1']);
  assert.deepEqual(result.extraIds, ['T1']);
});

// ---------------------------------------------------------------------------
// per-finding field bound violations
// ---------------------------------------------------------------------------

test('parseVerifySummary: verificationStatus outside the bounded enum produces one named violation', () => {
  const payload = {
    status: 'completed',
    reportFile: '/tmp/report.md',
    findings: [findingJson({ verificationStatus: 'looks-fine' })],
  };
  const result = parseVerifySummary(`VERIFY_SUMMARY: ${JSON.stringify(payload)}`, []);

  assert.equal(result.schemaOk, false);
  assert.ok(result.violations.some(v => /finding\.verificationStatus "looks-fine" not in bounded enum/.test(v)));
});

test('parseVerifySummary: finding missing id produces one named violation', () => {
  const payload = {
    status: 'completed',
    reportFile: '/tmp/report.md',
    findings: [findingJson({ id: undefined })],
  };
  const result = parseVerifySummary(`VERIFY_SUMMARY: ${JSON.stringify(payload)}`, []);

  assert.equal(result.schemaOk, false);
  assert.ok(result.violations.includes('finding missing required string field: id'));
});

test('parseVerifySummary: a non-object findings entry reports a violation instead of throwing', () => {
  const payload = {
    status: 'completed',
    reportFile: '/tmp/report.md',
    findings: [null],
  };
  const result = parseVerifySummary(`VERIFY_SUMMARY: ${JSON.stringify(payload)}`, []);

  assert.equal(result.schemaOk, false);
  assert.ok(result.violations.includes('finding is not an object'));
});

test('parseVerifySummary: evidence not an array produces one named violation', () => {
  const payload = {
    status: 'completed',
    reportFile: '/tmp/report.md',
    findings: [findingJson({ evidence: 'not-an-array' })],
  };
  const result = parseVerifySummary(`VERIFY_SUMMARY: ${JSON.stringify(payload)}`, []);

  assert.equal(result.schemaOk, false);
  assert.ok(result.violations.some(v => /finding\.evidence must be an array/.test(v)));
});

test('parseVerifySummary: evidence longer than MAX_EVIDENCE produces one named violation', () => {
  const payload = {
    status: 'completed',
    reportFile: '/tmp/report.md',
    findings: [findingJson({ evidence: Array.from({ length: MAX_EVIDENCE + 1 }, (_, i) => `f.js:${i}`) })],
  };
  const result = parseVerifySummary(`VERIFY_SUMMARY: ${JSON.stringify(payload)}`, []);

  assert.equal(result.schemaOk, false);
  assert.ok(result.violations.some(v => new RegExp(`finding\\.evidence exceeds max of ${MAX_EVIDENCE} entries`).test(v)));
});

test('parseVerifySummary: rippleEffects longer than MAX_RIPPLE produces one named violation', () => {
  const payload = {
    status: 'completed',
    reportFile: '/tmp/report.md',
    findings: [findingJson({ rippleEffects: Array.from({ length: MAX_RIPPLE + 1 }, (_, i) => `effect ${i}`) })],
  };
  const result = parseVerifySummary(`VERIFY_SUMMARY: ${JSON.stringify(payload)}`, []);

  assert.equal(result.schemaOk, false);
  assert.ok(result.violations.some(v => new RegExp(`finding\\.rippleEffects exceeds max of ${MAX_RIPPLE} entries`).test(v)));
});

test('parseVerifySummary: reasoning longer than MAX_REASONING_CHARS produces one named violation', () => {
  const payload = {
    status: 'completed',
    reportFile: '/tmp/report.md',
    findings: [findingJson({ reasoning: 'x'.repeat(MAX_REASONING_CHARS + 1) })],
  };
  const result = parseVerifySummary(`VERIFY_SUMMARY: ${JSON.stringify(payload)}`, []);

  assert.equal(result.schemaOk, false);
  assert.ok(result.violations.some(v => new RegExp(`finding\\.reasoning exceeds max of ${MAX_REASONING_CHARS} chars`).test(v)));
});

test('parseVerifySummary: non-string reasoning produces one named violation', () => {
  const payload = {
    status: 'completed',
    reportFile: '/tmp/report.md',
    findings: [findingJson({ reasoning: 42 })],
  };
  const result = parseVerifySummary(`VERIFY_SUMMARY: ${JSON.stringify(payload)}`, []);

  assert.equal(result.schemaOk, false);
  assert.ok(result.violations.some(v => /finding\.reasoning must be a string/.test(v)));
});

test('parseVerifySummary: non-string reportFile produces one named violation', () => {
  const payload = {
    status: 'completed',
    reportFile: 42,
    findings: [findingJson()],
  };
  const result = parseVerifySummary(`VERIFY_SUMMARY: ${JSON.stringify(payload)}`, []);

  assert.equal(result.schemaOk, false);
  assert.ok(result.violations.some(v => /parsed\.reportFile must be a string/.test(v)));
});

// ---------------------------------------------------------------------------
// missing token / parse error / non-array findings
// ---------------------------------------------------------------------------

test('parseVerifySummary: missing token sets missingIds to the full dispatched list', () => {
  const result = parseVerifySummary('no token here', ['PRRT_kwDOA1']);

  assert.equal(result.tokenFound, false);
  assert.equal(result.parsed, null);
  assert.equal(result.schemaOk, false);
  assert.deepEqual(result.missingIds, ['PRRT_kwDOA1']);
  assert.match(result.violations[0], /VERIFY_SUMMARY token not found as final non-blank line of output/);
});

test('parseVerifySummary: JSON parse error sets missingIds to the full dispatched list', () => {
  const result = parseVerifySummary('VERIFY_SUMMARY: {not valid json}', ['PRRT_kwDOA1']);

  assert.equal(result.tokenFound, true);
  assert.equal(result.parsed, null);
  assert.equal(result.schemaOk, false);
  assert.deepEqual(result.missingIds, ['PRRT_kwDOA1']);
  assert.match(result.violations[0], /VERIFY_SUMMARY JSON parse error/);
});

test('parseVerifySummary: non-array findings sets missingIds to the full dispatched list', () => {
  const payload = { status: 'completed', reportFile: '/tmp/report.md', findings: 'not-an-array' };
  const result = parseVerifySummary(`VERIFY_SUMMARY: ${JSON.stringify(payload)}`, ['PRRT_kwDOA1']);

  assert.equal(result.tokenFound, true);
  assert.deepEqual(result.parsed, payload);
  assert.equal(result.schemaOk, false);
  assert.deepEqual(result.missingIds, ['PRRT_kwDOA1']);
  assert.ok(result.violations.some(v => /parsed\.findings must be an array/.test(v)));
});

test('parseVerifySummary: non-string input text is treated as unparseable', () => {
  const result = parseVerifySummary(undefined, ['PRRT_kwDOA1']);

  assert.equal(result.tokenFound, false);
  assert.equal(result.schemaOk, false);
  assert.deepEqual(result.missingIds, ['PRRT_kwDOA1']);
  assert.match(result.violations[0], /input text is not a string/);
});

// ---------------------------------------------------------------------------
// top-level status enum
// ---------------------------------------------------------------------------

test('parseVerifySummary: status outside the bounded enum produces one named violation', () => {
  const payload = { status: 'in-progress', reportFile: '/tmp/report.md', findings: [] };
  const result = parseVerifySummary(`VERIFY_SUMMARY: ${JSON.stringify(payload)}`, []);

  assert.equal(result.schemaOk, false);
  assert.ok(result.violations.some(v => /parsed\.status "in-progress" not in bounded enum \(completed\|partial\|failed\)/.test(v)));
});
