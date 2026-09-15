'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { parseWaveSummary, extractFinalLineToken } = require('./wave-summary');

// ---------------------------------------------------------------------------
// extractFinalLineToken
// ---------------------------------------------------------------------------

test('extractFinalLineToken: finds token on final non-blank line', () => {
  assert.deepEqual(
    extractFinalLineToken('a\nWAVE_SUMMARY: {"x":1}\n\n', 'WAVE_SUMMARY:'),
    { found: true, payload: '{"x":1}' }
  );
});

test('extractFinalLineToken: not found when final non-blank line lacks the prefix', () => {
  assert.deepEqual(
    extractFinalLineToken('WAVE_SUMMARY: {"x":1}\nsome trailing line', 'WAVE_SUMMARY:'),
    { found: false, payload: null }
  );
});

test('extractFinalLineToken: not found when text is not a string', () => {
  assert.deepEqual(extractFinalLineToken(undefined, 'WAVE_SUMMARY:'), { found: false, payload: null });
  assert.deepEqual(extractFinalLineToken(null, 'WAVE_SUMMARY:'), { found: false, payload: null });
  assert.deepEqual(extractFinalLineToken(42, 'WAVE_SUMMARY:'), { found: false, payload: null });
});

test('extractFinalLineToken: not found when text is empty', () => {
  assert.deepEqual(extractFinalLineToken('', 'WAVE_SUMMARY:'), { found: false, payload: null });
});

test('extractFinalLineToken: only the final non-blank line is inspected (token followed by non-blank line is not found)', () => {
  const text = 'WAVE_SUMMARY: {"x":1}\nWAVE_SUMMARY: not this one either\nnot the token line';
  assert.deepEqual(extractFinalLineToken(text, 'WAVE_SUMMARY:'), { found: false, payload: null });
});

// ---------------------------------------------------------------------------
// parseWaveSummary — behaviour must be unchanged after the refactor
// ---------------------------------------------------------------------------

test('parseWaveSummary: valid token', () => {
  const text = 'WAVE_SUMMARY: {"wave":1,"status":"completed","tasks":[{"id":"1","status":"DONE","filesTouched":[]}],"escalationsUsed":0}';
  const result = parseWaveSummary(text, ['1']);

  assert.equal(result.tokenFound, true);
  assert.equal(result.schemaOk, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.missingIds, []);
  assert.deepEqual(result.extraIds, []);
  assert.deepEqual(result.returned, ['1']);
});

test('parseWaveSummary: missing token', () => {
  const result = parseWaveSummary('no token here', ['1']);

  assert.equal(result.tokenFound, false);
  assert.equal(result.schemaOk, false);
  assert.deepEqual(result.missingIds, ['1']);
  assert.match(result.violations[0], /WAVE_SUMMARY token not found as final non-blank line of output/);
});

test('parseWaveSummary: JSON parse error', () => {
  const result = parseWaveSummary('WAVE_SUMMARY: {not valid json}', ['1']);

  assert.equal(result.tokenFound, true);
  assert.equal(result.schemaOk, false);
  assert.deepEqual(result.missingIds, ['1']);
  assert.match(result.violations[0], /WAVE_SUMMARY JSON parse error/);
});

test('parseWaveSummary: missing IDs', () => {
  const text = 'WAVE_SUMMARY: {"wave":1,"status":"partial","tasks":[{"id":"1","status":"DONE","filesTouched":[]}],"escalationsUsed":0}';
  const result = parseWaveSummary(text, ['1', '2']);

  assert.equal(result.schemaOk, false);
  assert.deepEqual(result.missingIds, ['2']);
  assert.ok(result.violations.some(v => /CONTEXT_OVERFLOW/.test(v)));
});

test('parseWaveSummary: extra IDs', () => {
  const text = 'WAVE_SUMMARY: {"wave":1,"status":"completed","tasks":[{"id":"1","status":"DONE","filesTouched":[]},{"id":"9","status":"DONE","filesTouched":[]}],"escalationsUsed":0}';
  const result = parseWaveSummary(text, ['1']);

  assert.equal(result.schemaOk, false);
  assert.deepEqual(result.extraIds, ['9']);
  assert.ok(result.violations.some(v => /extra task IDs in WAVE_SUMMARY not in dispatched set/.test(v)));
});

test('parseWaveSummary: dropped fields', () => {
  const text = 'WAVE_SUMMARY: {"wave":1,"status":"completed","tasks":[{"id":"1","status":"DONE","filesTouched":[],"name":"should not be here"}],"escalationsUsed":0}';
  const result = parseWaveSummary(text, ['1']);

  assert.equal(result.schemaOk, false);
  assert.ok(result.violations.some(v => /task contains dropped field "name"/.test(v)));
});
