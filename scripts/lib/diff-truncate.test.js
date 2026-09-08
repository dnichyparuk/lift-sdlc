'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { truncateDiff, truncateText, DEFAULT_DIFF_MAX_BYTES } = require('./diff-truncate.js');
const { splitDiffByFile } = require('./git.js');

function fileChunk(path, bodyLines) {
  return `diff --git a/${path} b/${path}\nindex 0000000..1111111 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${bodyLines.length} @@\n${bodyLines.join('\n')}\n`;
}

test('truncateDiff: returns unchanged diff when under maxBytes', () => {
  const diff = fileChunk('a.js', ['+line']);
  const result = truncateDiff(diff, { splitDiffByFile, maxBytes: 100000 });
  assert.strictEqual(result.diff, diff);
  assert.strictEqual(result.diffTruncated, false);
  assert.deepStrictEqual(result.truncatedFiles, []);
});

test('truncateDiff: falls back to the original diff when splitDiffByFile finds zero files (regression for the unreachable-guard bug)', () => {
  // A diff that is over maxBytes but does not contain any `diff --git` header
  // (so splitDiffByFile returns an empty Map) must fall back to the original
  // fullDiff — not silently return an empty string. This is the exact bug:
  // the fileChunks.size === 0 guard was previously placed after code that
  // already early-returned an empty diff for an empty fileChunks Map.
  const opaqueBlob = 'x'.repeat(DEFAULT_DIFF_MAX_BYTES + 1000);
  const result = truncateDiff(opaqueBlob, { splitDiffByFile, maxBytes: DEFAULT_DIFF_MAX_BYTES });
  assert.strictEqual(result.diff, opaqueBlob, 'must fall back to the original diff, not return empty');
  assert.strictEqual(result.diffTruncated, false);
});

test('truncateDiff: excludes lockfile content but keeps a placeholder chunk', () => {
  const big = 'x'.repeat(DEFAULT_DIFF_MAX_BYTES);
  const diff = fileChunk('package-lock.json', [big]) + fileChunk('src/a.js', ['+real change']);
  // maxBytes must be large enough that (marker chunk + real chunk) fits after
  // exclusion, but smaller than the original (marker + 8000-char blob) diff —
  // otherwise the lockfile chunk falls through to the size-sorted omission
  // path instead of surviving as a marker.
  const result = truncateDiff(diff, { splitDiffByFile, maxBytes: 300 });
  assert.ok(result.diff.includes('[LOCKFILE EXCLUDED'), 'lockfile content should be replaced with the exclusion marker');
  assert.ok(!result.diff.includes(big), 'lockfile body content should not appear in the output');
});

test('truncateDiff: reduces unchanged-line context without dropping changed lines', () => {
  const contextLines = Array.from({ length: 50 }, (_, i) => ` unchanged line ${i}`);
  const diff = `diff --git a/f.js b/f.js\nindex 0000000..1111111 100644\n--- a/f.js\n+++ b/f.js\n@@ -1,50 +1,51 @@\n${contextLines.join('\n')}\n+added line\n`;
  const result = truncateDiff(diff, { splitDiffByFile, maxBytes: 100 });
  assert.ok(result.diff.includes('+added line'), 'changed line must survive context reduction');
  assert.ok(result.diff.includes(' ...'), 'reduced context should be collapsed to an ellipsis marker');
});

test('truncateDiff: omits and lists files beyond the byte budget', () => {
  const small = fileChunk('a.js', ['+x']);
  const big = fileChunk('b.js', ['x'.repeat(500)]);
  const diff = small + big;
  const result = truncateDiff(diff, { splitDiffByFile, maxBytes: 50 });
  assert.strictEqual(result.diffTruncated, true);
  assert.ok(result.diff.includes('--- Truncated ---'));
});

test('truncateDiff: throws when splitDiffByFile is not a function', () => {
  assert.throws(() => truncateDiff('x'.repeat(DEFAULT_DIFF_MAX_BYTES + 1), { maxBytes: DEFAULT_DIFF_MAX_BYTES }), /splitDiffByFile is required/);
});

test('truncateText: returns unchanged text under the cap', () => {
  const result = truncateText('short', { maxBytes: 100 });
  assert.strictEqual(result.text, 'short');
  assert.strictEqual(result.truncated, false);
});

test('truncateText: slices and flags text over the cap', () => {
  const result = truncateText('0123456789', { maxBytes: 5 });
  assert.strictEqual(result.text, '01234');
  assert.strictEqual(result.truncated, true);
});

test('truncateText: requires a non-negative maxBytes', () => {
  assert.throws(() => truncateText('x', {}), /maxBytes.*required/);
  assert.throws(() => truncateText('x', { maxBytes: -1 }), /maxBytes.*required/);
});
