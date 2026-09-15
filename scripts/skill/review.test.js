'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { writeDimensionDiffs, DIMENSION_DIFF_WARN_BYTES, loadAndMatchDimensions } = require('./review.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileChunk(filePath, body) {
  return `diff --git a/${filePath} b/${filePath}\nindex 0000000..1111111 100644\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,1 +1,1 @@\n${body}\n`;
}

function makeDim(overrides) {
  return {
    name: 'test-dim',
    matched_files: [],
    warnings: [],
    max_diff_bytes: null,
    ...overrides,
  };
}

function readDiffFile(dim) {
  return fs.readFileSync(dim.diff_file, 'utf8');
}

// Cleans up the tmpdir writeDimensionDiffs created so tests don't litter
// the OS temp directory across runs.
function cleanup(tmpDir) {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Constant
// ---------------------------------------------------------------------------

test('DIMENSION_DIFF_WARN_BYTES is 64 KiB', () => {
  assert.strictEqual(DIMENSION_DIFF_WARN_BYTES, 64 * 1024);
});

// ---------------------------------------------------------------------------
// Under both thresholds — byte-identical to prior behaviour
// ---------------------------------------------------------------------------

test('writeDimensionDiffs: under warn threshold and no cap leaves diff untouched', () => {
  const chunk = fileChunk('a.js', '+small change');
  const fileDiffs = new Map([['a.js', chunk]]);
  const dim = makeDim({ matched_files: ['a.js'] });

  const tmpDir = writeDimensionDiffs([dim], fileDiffs, '/project');
  try {
    assert.strictEqual(readDiffFile(dim), chunk);
    assert.strictEqual(dim.diff_bytes, chunk.length);
    assert.strictEqual(dim.diff_oversize, false);
    assert.strictEqual(dim.diff_truncated, false);
    assert.deepStrictEqual(dim.diff_omitted_files, []);
    assert.deepStrictEqual(dim.warnings, []);
  } finally {
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Oversize, no cap — warn only, full diff preserved
// ---------------------------------------------------------------------------

test('writeDimensionDiffs: oversize diff with no cap keeps full content and warns', () => {
  const bigBody = 'x'.repeat(DIMENSION_DIFF_WARN_BYTES + 5000);
  const chunk = fileChunk('a.js', bigBody);
  const fileDiffs = new Map([['a.js', chunk]]);
  const dim = makeDim({ matched_files: ['a.js'] });

  const tmpDir = writeDimensionDiffs([dim], fileDiffs, '/project');
  try {
    assert.strictEqual(readDiffFile(dim), chunk, 'full diff must be written unchanged');
    assert.strictEqual(dim.diff_bytes, chunk.length);
    assert.strictEqual(dim.diff_oversize, true);
    assert.strictEqual(dim.diff_truncated, false);
    assert.deepStrictEqual(dim.diff_omitted_files, []);

    const kb = Math.round(dim.diff_bytes / 1024);
    const thresholdKb = Math.round(DIMENSION_DIFF_WARN_BYTES / 1024);
    assert.ok(
      dim.warnings.includes(
        `Diff is ${kb} KB (> ${thresholdKb} KB); consider narrowing this dimension's triggers or setting max-diff-bytes`
      ),
      `warnings should contain the oversize hint, got: ${JSON.stringify(dim.warnings)}`
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Cap set and exceeded — truncation applied, files omitted, warning added
// ---------------------------------------------------------------------------

test('writeDimensionDiffs: max-diff-bytes cap truncates, lists omitted files, and warns', () => {
  const smallChunk = fileChunk('a.js', '+x');
  const bigChunk = fileChunk('b.js', 'y'.repeat(500));
  const fileDiffs = new Map([
    ['a.js', smallChunk],
    ['b.js', bigChunk],
  ]);
  const dim = makeDim({ matched_files: ['a.js', 'b.js'], max_diff_bytes: 50 });

  const tmpDir = writeDimensionDiffs([dim], fileDiffs, '/project');
  try {
    const written = readDiffFile(dim);
    const fullDiff = smallChunk + '\n' + bigChunk;
    assert.notStrictEqual(written, fullDiff, 'diff should be truncated, not the full joined diff');
    assert.ok(written.includes('--- Truncated ---'), 'truncated output should carry the footer marker');
    assert.strictEqual(dim.diff_truncated, true);
    assert.ok(dim.diff_omitted_files.length > 0, 'at least one file should be listed as omitted');
    assert.ok(dim.diff_omitted_files.includes('a.js'), 'the smaller file is dropped since the largest chunk is always kept first');
    assert.ok(
      dim.warnings.some(w => w.startsWith('Diff truncated to') && w.includes('omitted:')),
      `warnings should contain the truncation notice, got: ${JSON.stringify(dim.warnings)}`
    );
    // diff_oversize reflects the ORIGINAL joined size, not the truncated size.
    assert.strictEqual(dim.diff_bytes, (smallChunk + '\n' + bigChunk).length);
  } finally {
    cleanup(tmpDir);
  }
});

test('writeDimensionDiffs: cap under warn threshold truncates without an oversize warning', () => {
  const smallChunk = fileChunk('a.js', '+x');
  const bigChunk = fileChunk('b.js', 'y'.repeat(50));
  const fileDiffs = new Map([
    ['a.js', smallChunk],
    ['b.js', bigChunk],
  ]);
  const dim = makeDim({ matched_files: ['a.js', 'b.js'], max_diff_bytes: 10 });

  const tmpDir = writeDimensionDiffs([dim], fileDiffs, '/project');
  try {
    assert.strictEqual(dim.diff_oversize, false, 'joined diff is well under the 64 KiB warn threshold');
    assert.strictEqual(dim.diff_truncated, true);
    assert.ok(!dim.warnings.some(w => w.includes('consider narrowing')), 'no oversize hint expected');
  } finally {
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Invalid max-diff-bytes — ignored with a warning, behaves as absent
// ---------------------------------------------------------------------------

for (const invalid of [0, -5, 3.5, 'abc']) {
  test(`writeDimensionDiffs: invalid max-diff-bytes (${JSON.stringify(invalid)}) is ignored with a warning`, () => {
    const chunk = fileChunk('a.js', '+small change');
    const fileDiffs = new Map([['a.js', chunk]]);
    const dim = makeDim({ matched_files: ['a.js'], max_diff_bytes: invalid });

    const tmpDir = writeDimensionDiffs([dim], fileDiffs, '/project');
    try {
      assert.strictEqual(readDiffFile(dim), chunk, 'diff must be left full, as if the cap were absent');
      assert.strictEqual(dim.diff_truncated, false);
      assert.deepStrictEqual(dim.diff_omitted_files, []);
      assert.ok(
        dim.warnings.some(w => w.startsWith('Invalid max-diff-bytes')),
        `warnings should flag the invalid cap, got: ${JSON.stringify(dim.warnings)}`
      );
    } finally {
      cleanup(tmpDir);
    }
  });
}

test('writeDimensionDiffs: max_diff_bytes absent (null) behaves as no cap, without an invalid-cap warning', () => {
  const chunk = fileChunk('a.js', '+small change');
  const fileDiffs = new Map([['a.js', chunk]]);
  const dim = makeDim({ matched_files: ['a.js'], max_diff_bytes: null });

  const tmpDir = writeDimensionDiffs([dim], fileDiffs, '/project');
  try {
    assert.strictEqual(dim.diff_truncated, false);
    assert.ok(!dim.warnings.some(w => w.startsWith('Invalid max-diff-bytes')));
  } finally {
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Injected splitDiffByFile (dependency injection option)
// ---------------------------------------------------------------------------

test('writeDimensionDiffs: uses an injected splitDiffByFile for truncation', () => {
  const smallChunk = fileChunk('a.js', '+x');
  const bigChunk = fileChunk('b.js', 'y'.repeat(500));
  const fileDiffs = new Map([
    ['a.js', smallChunk],
    ['b.js', bigChunk],
  ]);
  const dim = makeDim({ matched_files: ['a.js', 'b.js'], max_diff_bytes: 50 });

  let called = false;
  const fakeSplit = (raw) => {
    called = true;
    const { splitDiffByFile } = require(path.join(__dirname, '..', 'lib', 'git'));
    return splitDiffByFile(raw);
  };

  const tmpDir = writeDimensionDiffs([dim], fileDiffs, '/project', { splitDiffByFile: fakeSplit });
  try {
    assert.strictEqual(called, true, 'the injected splitDiffByFile should be used, not the module default');
    assert.strictEqual(dim.diff_truncated, true);
  } finally {
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Existing no-diff-content warning behaviour is preserved
// ---------------------------------------------------------------------------

test('writeDimensionDiffs: still warns about matched files with no diff content', () => {
  const fileDiffs = new Map();
  const dim = makeDim({ matched_files: ['missing.js'] });

  const tmpDir = writeDimensionDiffs([dim], fileDiffs, '/project');
  try {
    assert.ok(dim.warnings.some(w => w.includes('No diff content for: missing.js')));
    assert.strictEqual(readDiffFile(dim), '');
    assert.strictEqual(dim.diff_bytes, 0);
    assert.strictEqual(dim.diff_oversize, false);
  } finally {
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// loadAndMatchDimensions: max-diff-bytes frontmatter -> max_diff_bytes wiring
// ---------------------------------------------------------------------------

function mkTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-prepare-'));
}

function writeDimensionFixture(projectRoot, fileName, frontmatterExtra) {
  const dimsDir = path.join(projectRoot, '.sdlc', 'review-dimensions');
  fs.mkdirSync(dimsDir, { recursive: true });
  fs.writeFileSync(
    path.join(dimsDir, fileName),
    `---\nname: ${fileName.replace(/\.md$/, '')}\ndescription: A test dimension.\n${frontmatterExtra}---\n\nReview instructions go here, well past ten characters.\n`,
    'utf8'
  );
}

test('loadAndMatchDimensions: reads frontmatter "max-diff-bytes" into dim.max_diff_bytes', () => {
  const projectRoot = mkTempProject();
  try {
    writeDimensionFixture(projectRoot, 'dim-with-cap.md', 'triggers:\n  - "big.js"\nmax-diff-bytes: 50\n');
    writeDimensionFixture(projectRoot, 'dim-no-cap.md', 'triggers:\n  - "small.js"\n');

    const dims = loadAndMatchDimensions(projectRoot, ['big.js', 'small.js'], null);

    const withCap = dims.find(d => d.name === 'dim-with-cap');
    const noCap = dims.find(d => d.name === 'dim-no-cap');
    assert.ok(withCap, 'dim-with-cap should be present');
    assert.ok(noCap, 'dim-no-cap should be present');
    assert.strictEqual(withCap.max_diff_bytes, 50);
    assert.strictEqual(noCap.max_diff_bytes, null, 'absent max-diff-bytes must surface as null, not undefined');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// oversize_dimensions / byte_truncated_dimensions summary counters (main())
//
// main() itself is not exported (it shells out to git/gh and calls
// process.exit), so this exercises the same two building blocks main() uses
// — loadAndMatchDimensions() then writeDimensionDiffs() — and reproduces
// main()'s exact summary filter expressions against the result.
// ---------------------------------------------------------------------------

test('summary counters: oversize_dimensions and byte_truncated_dimensions reflect loadAndMatchDimensions + writeDimensionDiffs output', () => {
  const projectRoot = mkTempProject();
  try {
    // dim-with-cap matches "big.js" and sets a byte cap small enough to force truncation.
    writeDimensionFixture(projectRoot, 'dim-with-cap.md', 'triggers:\n  - "big.js"\nmax-diff-bytes: 50\n');
    // dim-no-cap matches "small.js" and has no cap.
    writeDimensionFixture(projectRoot, 'dim-no-cap.md', 'triggers:\n  - "small.js"\n');

    const changedFiles = ['big.js', 'small.js'];
    const dims = loadAndMatchDimensions(projectRoot, changedFiles, null);

    const bigChunk = fileChunk('big.js', 'y'.repeat(DIMENSION_DIFF_WARN_BYTES + 1024));
    const smallChunk = fileChunk('small.js', '+x');
    const fileDiffs = new Map([
      ['big.js', bigChunk],
      ['small.js', smallChunk],
    ]);

    const activeDims = dims.filter(d => d.status === 'ACTIVE' || d.status === 'TRUNCATED');
    const tmpDir = writeDimensionDiffs(activeDims, fileDiffs, projectRoot);
    try {
      // Mirrors the summary computation in review.js main().
      const oversizeDimensions = dims.filter(d => d.diff_oversize).length;
      const byteTruncatedDimensions = dims.filter(d => d.diff_truncated).length;

      assert.strictEqual(oversizeDimensions, 1, 'only the big.js dimension exceeds DIMENSION_DIFF_WARN_BYTES');
      assert.strictEqual(byteTruncatedDimensions, 1, 'only the capped dimension gets truncated');

      const withCap = dims.find(d => d.name === 'dim-with-cap');
      const noCap = dims.find(d => d.name === 'dim-no-cap');
      assert.strictEqual(withCap.diff_oversize, true);
      assert.strictEqual(withCap.diff_truncated, true);
      assert.strictEqual(noCap.diff_oversize, false);
      assert.strictEqual(noCap.diff_truncated, false);
    } finally {
      cleanup(tmpDir);
    }
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
