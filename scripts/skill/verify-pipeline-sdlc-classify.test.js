'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { classifyLogs } = require('./verify-pipeline-sdlc-classify');

// ---------------------------------------------------------------------------
// classifyLogs — category & routingBucket mapping
// ---------------------------------------------------------------------------

test('classifyLogs: lint category maps to actionable routingBucket', () => {
  const result = classifyLogs('eslint error: something');
  assert.strictEqual(result.category, 'lint');
  assert.strictEqual(result.routingBucket, 'actionable');
});

test('classifyLogs: test-failure category maps to actionable routingBucket', () => {
  const result = classifyLogs('AssertionError: expected 1 to equal 2');
  assert.strictEqual(result.category, 'test-failure');
  assert.strictEqual(result.routingBucket, 'actionable');
});

test('classifyLogs: type-error category maps to actionable routingBucket', () => {
  const result = classifyLogs('TS2322: Type string is not assignable to type number');
  assert.strictEqual(result.category, 'type-error');
  assert.strictEqual(result.routingBucket, 'actionable');
});

test('classifyLogs: build-error category maps to always-proposal routingBucket', () => {
  const result = classifyLogs('Cannot find module "./missing"');
  assert.strictEqual(result.category, 'build-error');
  assert.strictEqual(result.routingBucket, 'always-proposal');
});

test('classifyLogs: dependency category maps to always-proposal routingBucket', () => {
  const result = classifyLogs('npm ERR! code ENOENT');
  assert.strictEqual(result.category, 'dependency');
  assert.strictEqual(result.routingBucket, 'always-proposal');
});

test('classifyLogs: infra category maps to always-proposal routingBucket', () => {
  const result = classifyLogs('Runner lost communication');
  assert.strictEqual(result.category, 'infra');
  assert.strictEqual(result.routingBucket, 'always-proposal');
});

test('classifyLogs: unknown category maps to always-proposal routingBucket', () => {
  const result = classifyLogs('some random log text with no patterns');
  assert.strictEqual(result.category, 'unknown');
  assert.strictEqual(result.routingBucket, 'always-proposal');
});

test('classifyLogs: empty text returns unknown with always-proposal', () => {
  const result = classifyLogs('');
  assert.strictEqual(result.category, 'unknown');
  assert.strictEqual(result.routingBucket, 'always-proposal');
});

// ---------------------------------------------------------------------------
// classifyLogs — signals are captured correctly
// ---------------------------------------------------------------------------

test('classifyLogs: lint signals are populated', () => {
  const result = classifyLogs('eslint problems (2 errors, 3 warnings)');
  assert.strictEqual(result.category, 'lint');
  assert(result.signals.length > 0);
  assert(result.signals.some((s) => s.startsWith('lint:')));
});

test('classifyLogs: test signals are populated', () => {
  const result = classifyLogs('2 failing tests');
  assert.strictEqual(result.category, 'test-failure');
  assert(result.signals.length > 0);
  assert(result.signals.some((s) => s.startsWith('test:')));
});

test('classifyLogs: type signals are populated', () => {
  const result = classifyLogs('TS2345: Argument of type "x" not assignable');
  assert.strictEqual(result.category, 'type-error');
  assert(result.signals.length > 0);
  assert(result.signals.some((s) => s.startsWith('type:')));
});
