'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { SECOND_MS, MINUTE_MS, HOUR_MS, DAY_MS } = require('./time-constants.js');

test('SECOND_MS is 1000', () => {
  assert.strictEqual(SECOND_MS, 1000);
});

test('MINUTE_MS is 60 seconds', () => {
  assert.strictEqual(MINUTE_MS, 60 * SECOND_MS);
  assert.strictEqual(MINUTE_MS, 60000);
});

test('HOUR_MS is 60 minutes', () => {
  assert.strictEqual(HOUR_MS, 60 * MINUTE_MS);
  assert.strictEqual(HOUR_MS, 3600000);
});

test('DAY_MS is 24 hours', () => {
  assert.strictEqual(DAY_MS, 24 * HOUR_MS);
  assert.strictEqual(DAY_MS, 86400000);
});
