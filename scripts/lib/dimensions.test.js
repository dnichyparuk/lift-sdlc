'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE_PATH = require.resolve('./dimensions');

function freshDimensions() {
  delete require.cache[MODULE_PATH];
  return require('./dimensions');
}

function mkTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dimensions-test-'));
}

test('resolveDimensionsDir: prefers .sdlc/review-dimensions when it exists, even if legacy also exists', () => {
  const projectRoot = mkTempProject();
  try {
    const newPath = path.join(projectRoot, '.sdlc', 'review-dimensions');
    const legacyPath = path.join(projectRoot, 'review-dimensions');
    fs.mkdirSync(newPath, { recursive: true });
    fs.mkdirSync(legacyPath, { recursive: true });

    const { resolveDimensionsDir } = freshDimensions();
    assert.strictEqual(resolveDimensionsDir(projectRoot), newPath);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('resolveDimensionsDir: falls back to legacy review-dimensions/ and emits a one-time stderr deprecation warning', () => {
  const projectRoot = mkTempProject();
  try {
    const legacyPath = path.join(projectRoot, 'review-dimensions');
    fs.mkdirSync(legacyPath, { recursive: true });

    const { resolveDimensionsDir } = freshDimensions();

    const writes = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk, ...args) => { writes.push(chunk); return originalWrite.call(process.stderr, chunk, ...args); };
    try {
      const first = resolveDimensionsDir(projectRoot);
      assert.strictEqual(first, legacyPath);
      assert.strictEqual(writes.length, 1);
      assert.ok(writes[0].includes('Deprecation'));

      // Second call for the same process must NOT re-emit the warning.
      const second = resolveDimensionsDir(projectRoot);
      assert.strictEqual(second, legacyPath);
      assert.strictEqual(writes.length, 1);
    } finally {
      process.stderr.write = originalWrite;
    }
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('resolveDimensionsDir: returns the new path when neither directory exists', () => {
  const projectRoot = mkTempProject();
  try {
    const { resolveDimensionsDir } = freshDimensions();
    const newPath = path.join(projectRoot, '.sdlc', 'review-dimensions');
    assert.strictEqual(resolveDimensionsDir(projectRoot), newPath);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
