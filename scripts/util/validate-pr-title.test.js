'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'validate-pr-title.js');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('validate-pr-title: exits 0 when the title matches the pattern (success path)', () => {
  const result = run(['feat(pr): add title validator', '^(feat|fix|chore)(\\(.+\\))?: .+', 'bad title']);
  assert.equal(result.status, 0);
});

test('validate-pr-title: exits 1 and prints the error-message when the title does not match (error path)', () => {
  const result = run(['update stuff', '^(feat|fix|chore)(\\(.+\\))?: .+', 'title must start with a conventional type']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /title must start with a conventional type/);
});

test('validate-pr-title: falls back to printing the pattern when no error-message is given', () => {
  const result = run(['update stuff', '^(feat|fix|chore)(\\(.+\\))?: .+']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\^\(feat\|fix\|chore\)/);
});

test('parseArgs: extracts the positional title, pattern, and error-message', () => {
  const { parseArgs } = require('./validate-pr-title');
  const { title, pattern, errorMessage } = parseArgs(
    ['node', 'validate-pr-title.js', 'feat: x', '^feat', 'must start with feat']
  );
  assert.equal(title, 'feat: x');
  assert.equal(pattern, '^feat');
  assert.equal(errorMessage, 'must start with feat');
});

test('validate-pr-title: missing pattern -> usage on stderr, exit 1', () => {
  const result = run(['feat: x']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^usage: validate-pr-title\.js <title> <pattern> \[errorMessage\]/);
});

test('validate-pr-title: missing title and pattern -> usage on stderr, exit 1', () => {
  const result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^usage: validate-pr-title\.js <title> <pattern> \[errorMessage\]/);
});

test('validate-pr-title: invalid regex pattern -> stderr message, exit 1', () => {
  const result = run(['feat: x', '(unclosed']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^invalid pattern: /);
});

test('validate-pr-title: empty-string title is still tested against the pattern, not rejected as missing', () => {
  const result = run(['', '^$']);
  assert.equal(result.status, 0);
});

test('validate-pr-title: regression — missing pattern must not coerce to the literal "undefined" and pass', () => {
  const result = run(['undefined']);
  assert.equal(result.status, 1);
});
