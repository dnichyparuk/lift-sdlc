'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { extractPlanFile } = require('./extract-plan-file');

function writeTempJson(obj) {
  const filePath = path.join(os.tmpdir(), `extract-plan-file-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');
  return filePath;
}

test('extractPlanFile: success path reads context.planFile from a JSON file', () => {
  const filePath = writeTempJson({ context: { planFile: '/repo/.sdlc/plans/my-plan.md' } });
  try {
    const result = extractPlanFile(filePath);
    assert.equal(result.ok, true);
    assert.equal(result.planFile, '/repo/.sdlc/plans/my-plan.md');
    assert.deepEqual(result.errors, []);
  } finally {
    fs.unlinkSync(filePath);
  }
});

test('extractPlanFile: success path defaults planFile to empty string when the key is absent', () => {
  const filePath = writeTempJson({ context: {} });
  try {
    const result = extractPlanFile(filePath);
    assert.equal(result.ok, true);
    assert.equal(result.planFile, '');
  } finally {
    fs.unlinkSync(filePath);
  }
});

test('extractPlanFile: error path — missing json-file-path argument', () => {
  const result = extractPlanFile(null);
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
  assert.match(result.errors[0], /JSON file path argument is required/);
  assert.equal(result.planFile, '');
});

test('extractPlanFile: error path — unreadable (nonexistent) file reports an errors[] entry, not a silent \'\'', () => {
  const missingPath = path.join(os.tmpdir(), `extract-plan-file-does-not-exist-${Date.now()}.json`);
  const result = extractPlanFile(missingPath);
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
  assert.match(result.errors[0], /Could not read JSON file/);
});

test('extractPlanFile: error path — malformed JSON reports an errors[] entry', () => {
  const filePath = path.join(os.tmpdir(), `extract-plan-file-malformed-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(filePath, '{ not valid json', 'utf8');
  try {
    const result = extractPlanFile(filePath);
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
    assert.match(result.errors[0], /Could not parse JSON/);
  } finally {
    fs.unlinkSync(filePath);
  }
});
