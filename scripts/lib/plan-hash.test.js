'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const crypto = require('node:crypto');

const { computePlanHash } = require('./plan-hash');

function withTempFile(contents, fn) {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-hash-lib-'));
  const file = path.join(dir, 'plan.md');
  fs.writeFileSync(file, contents);
  try {
    return fn(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('computePlanHash returns the SHA-256 hex digest of the file bytes', () => {
  const body = '# Plan\n\n- task 1\n- task 2\n';
  withTempFile(body, (file) => {
    const expected = crypto.createHash('sha256').update(Buffer.from(body)).digest('hex');
    assert.strictEqual(computePlanHash(file), expected);
  });
});

test('computePlanHash matches the known digest of the empty file', () => {
  withTempFile('', (file) => {
    assert.strictEqual(
      computePlanHash(file),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });
});

test('computePlanHash produces a 64-char lowercase hex digest', () => {
  withTempFile('anything', (file) => {
    assert.match(computePlanHash(file), /^[0-9a-f]{64}$/);
  });
});

test('computePlanHash is stable across repeated calls', () => {
  withTempFile('stable content\n', (file) => {
    assert.strictEqual(computePlanHash(file), computePlanHash(file));
  });
});

test('computePlanHash changes when a single byte changes', () => {
  withTempFile('plan a\n', (fileA) => {
    withTempFile('plan b\n', (fileB) => {
      assert.notStrictEqual(computePlanHash(fileA), computePlanHash(fileB));
    });
  });
});

test('computePlanHash hashes raw bytes, not a decoded string', () => {
  // Invalid UTF-8 byte sequence: reading as 'utf8' would replace it with
  // U+FFFD and change the digest.
  const bytes = Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a]);
  withTempFile(bytes, (file) => {
    const expected = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.strictEqual(computePlanHash(file), expected);
  });
});

test('computePlanHash propagates a read error for a missing file', () => {
  const missing = path.join(os.tmpdir(), 'plan-hash-does-not-exist-12345.md');
  assert.throws(() => computePlanHash(missing), /ENOENT/);
});
