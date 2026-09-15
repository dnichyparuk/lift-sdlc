'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, runParseVerify } = require('./parse-verify');

const SCRIPT = path.join(__dirname, 'parse-verify.js');

test('parseArgs: --dispatched-ids flag', () => {
  assert.deepEqual(
    parseArgs(['node', 'parse-verify.js', '--dispatched-ids', '["a","b"]']),
    { dispatchedIdsRaw: '["a","b"]' }
  );
});

test('parseArgs: no flags -> dispatchedIdsRaw is null', () => {
  assert.deepEqual(parseArgs(['node', 'parse-verify.js']), { dispatchedIdsRaw: null });
});

test('runParseVerify: success path — delegates to parseVerifySummary with parsed dispatched-ids array', () => {
  let calledWith = null;
  const parseVerifySummaryFn = (text, dispatched) => {
    calledWith = { text, dispatched };
    return { schemaOk: true, dispatched, returned: ['a', 'b'], missingIds: [], extraIds: [], parsed: {}, violations: [], tokenFound: true };
  };

  const { json, exitCode } = runParseVerify('VERIFY_SUMMARY: {}', '["a","b"]', { parseVerifySummaryFn });

  assert.deepEqual(calledWith, { text: 'VERIFY_SUMMARY: {}', dispatched: ['a', 'b'] });
  assert.equal(exitCode, 0);
  assert.equal(json.schemaOk, true);
});

test('runParseVerify: success path — no --dispatched-ids defaults to an empty array', () => {
  let calledWith = null;
  const parseVerifySummaryFn = (text, dispatched) => {
    calledWith = { text, dispatched };
    return { schemaOk: true, dispatched: [], returned: [], missingIds: [], extraIds: [], parsed: {}, violations: [], tokenFound: true };
  };

  const { exitCode } = runParseVerify('VERIFY_SUMMARY: {}', null, { parseVerifySummaryFn });

  assert.deepEqual(calledWith.dispatched, []);
  assert.equal(exitCode, 0);
});

test('runParseVerify: error path — --dispatched-ids is not valid JSON', () => {
  const parseVerifySummaryFn = () => {
    throw new Error('should not be called');
  };

  const { json, exitCode } = runParseVerify('VERIFY_SUMMARY: {}', 'not-json', { parseVerifySummaryFn });

  assert.equal(exitCode, 1);
  assert.equal(json.schemaOk, false);
  assert.match(json.error, /not valid JSON/);
});

test('runParseVerify: error path — --dispatched-ids is valid JSON but not an array', () => {
  const parseVerifySummaryFn = () => {
    throw new Error('should not be called');
  };

  const { json, exitCode } = runParseVerify('VERIFY_SUMMARY: {}', '{"a":1}', { parseVerifySummaryFn });

  assert.equal(exitCode, 1);
  assert.equal(json.schemaOk, false);
  assert.match(json.error, /must be a JSON array/);
});

// ---------------------------------------------------------------------------
// CLI integration — verifies stdin is read and a JSON line is written
// ---------------------------------------------------------------------------

test('CLI: reads verifier text from stdin and writes a JSON line to stdout', () => {
  const verifySummaryText = 'VERIFY_SUMMARY: {"status":"completed","reportFile":"report.md","findings":[{"id":"a","verificationStatus":"confirmed","evidence":[],"rippleEffects":[],"reasoning":"ok"}]}';

  const res = spawnSync(process.execPath, [SCRIPT, '--dispatched-ids', '["a"]'], {
    input: verifySummaryText,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.schemaOk, true);
  assert.equal(parsed.tokenFound, true);
  assert.deepEqual(parsed.missingIds, []);
});

test('CLI: exits 1 with a JSON error when --dispatched-ids is malformed', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--dispatched-ids', 'nope'], {
    input: 'VERIFY_SUMMARY: {}',
    encoding: 'utf8',
  });

  assert.equal(res.status, 1);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.schemaOk, false);
});
