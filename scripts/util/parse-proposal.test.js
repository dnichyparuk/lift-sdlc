'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');
const { PassThrough } = require('node:stream');

const { parseArgs, extractProposalField, runParseProposal, readStdin } = require('./parse-proposal');

const SCRIPT = path.join(__dirname, 'parse-proposal.js');

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: field positional argument', () => {
  assert.deepEqual(
    parseArgs(['node', 'parse-proposal.js', 'title']),
    { field: 'title', errors: [] }
  );
});

test('parseArgs: missing field -> error', () => {
  assert.deepEqual(
    parseArgs(['node', 'parse-proposal.js']),
    { field: undefined, errors: ['Missing field'] }
  );
});

// ---------------------------------------------------------------------------
// extractProposalField — exact `.proposal[field] || ''` lookup shape
// ---------------------------------------------------------------------------

test('extractProposalField: returns the requested field', () => {
  assert.equal(
    extractProposalField('title', '{"proposal":{"title":"Fix the bug","body":"details"}}'),
    'Fix the bug'
  );
});

test('extractProposalField: missing key on proposal falls back to empty string', () => {
  assert.equal(extractProposalField('summary', '{"proposal":{"title":"x"}}'), '');
});

test('extractProposalField: falsy value (empty string) falls back to empty string', () => {
  assert.equal(extractProposalField('title', '{"proposal":{"title":""}}'), '');
});

test('extractProposalField: throws on invalid JSON', () => {
  assert.throws(() => extractProposalField('title', 'not-json'));
});

test('extractProposalField: throws when proposal object is absent', () => {
  assert.throws(() => extractProposalField('title', '{"other":1}'));
});

// ---------------------------------------------------------------------------
// runParseProposal (in-process, injected stdin)
// ---------------------------------------------------------------------------

function fakeStdin(text) {
  const { EventEmitter } = require('node:events');
  const stream = new EventEmitter();
  stream.setEncoding = () => {};
  stream.resume = () => {};
  process.nextTick(() => {
    stream.emit('data', text);
    stream.emit('end');
  });
  return stream;
}

test('runParseProposal: success path writes the field with no trailing newline', async () => {
  const result = await runParseProposal(
    ['node', 'parse-proposal.js', 'title'],
    { stdin: fakeStdin('{"proposal":{"title":"Hello"}}') }
  );
  assert.deepEqual(result, { exitCode: 0, stdout: 'Hello', stderr: null });
});

test('runParseProposal: missing field argument exits 2', async () => {
  const result = await runParseProposal(
    ['node', 'parse-proposal.js'],
    { stdin: fakeStdin('{"proposal":{"title":"Hello"}}') }
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Missing field/);
});

test('runParseProposal: invalid stdin JSON exits 2', async () => {
  const result = await runParseProposal(
    ['node', 'parse-proposal.js', 'title'],
    { stdin: fakeStdin('not-json') }
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /ERROR:/);
});

// ---------------------------------------------------------------------------
// CLI integration — verifies stdin is read via process.stdin
// ---------------------------------------------------------------------------

test('CLI: extracts a field from JSON piped on stdin', () => {
  const res = spawnSync(process.execPath, [SCRIPT, 'body'], {
    input: '{"proposal":{"title":"T","body":"B"}}',
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'B');
});

test('CLI: exits 2 with no field argument', () => {
  const res = spawnSync(process.execPath, [SCRIPT], {
    input: '{"proposal":{"title":"T"}}',
    encoding: 'utf8',
  });

  assert.equal(res.status, 2);
  assert.match(res.stderr, /Missing field/);
});

test('CLI: exits 2 on invalid JSON stdin', () => {
  const res = spawnSync(process.execPath, [SCRIPT, 'title'], {
    input: 'not-json',
    encoding: 'utf8',
  });

  assert.equal(res.status, 2);
  assert.match(res.stderr, /ERROR:/);
});

// ---------------------------------------------------------------------------
// readStdin — listener hygiene
// ---------------------------------------------------------------------------

test('readStdin: removes its data/end/error listeners from the stream on settle', async () => {
  const stream = new PassThrough();
  const promise = readStdin(stream);
  stream.end('{"proposal":{"title":"Hello"}}');
  const result = await promise;
  assert.equal(result, '{"proposal":{"title":"Hello"}}');
  assert.equal(stream.listenerCount('data'), 0);
  assert.equal(stream.listenerCount('end'), 0);
  assert.equal(stream.listenerCount('error'), 0);
});
