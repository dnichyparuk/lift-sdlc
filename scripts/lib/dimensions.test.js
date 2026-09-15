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

// ---------------------------------------------------------------------------
// KNOWN_FIELDS / D11 unknown-field validation — max-diff-bytes
// ---------------------------------------------------------------------------

function makeDimensionFile(dir, frontmatterExtra) {
  const file = path.join(dir, 'dimension.md');
  fs.writeFileSync(
    file,
    `---\nname: my-dimension\ndescription: A test dimension.\ntriggers:\n  - "**/*.js"\n${frontmatterExtra}---\n\nReview instructions go here, well past ten characters.\n`,
    'utf8'
  );
  return file;
}

test('validateDimensionFile: max-diff-bytes in frontmatter produces no D11 unknown-field warning', () => {
  const projectRoot = mkTempProject();
  try {
    const file = makeDimensionFile(projectRoot, 'max-diff-bytes: 50000\n');
    const { validateDimensionFile, KNOWN_FIELDS } = freshDimensions();

    assert.ok(KNOWN_FIELDS.has('max-diff-bytes'), 'max-diff-bytes must be a known field');

    const { warnings } = validateDimensionFile(file);
    assert.ok(
      !warnings.some(w => w.check === 'D11'),
      `expected no D11 warnings, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('validateDimensionFile: a typo\'d "max-diff-byte" still triggers a D11 warning with a suggestion', () => {
  const projectRoot = mkTempProject();
  try {
    const file = makeDimensionFile(projectRoot, 'max-diff-byte: 50000\n');
    const { validateDimensionFile } = freshDimensions();

    const { warnings } = validateDimensionFile(file);
    const d11 = warnings.find(w => w.check === 'D11');
    assert.ok(d11, 'expected a D11 warning for the unknown field');
    assert.match(d11.message, /max-diff-byte/);
    assert.match(d11.message, /did you mean: max-diff-bytes/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
