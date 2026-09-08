'use strict';

/**
 * diff-truncate.js
 * Single source for large-input truncation across the corpus.
 *
 * Two strategies, one module:
 *
 *   - `truncateDiff(diff, { maxBytes, splitDiffByFile })` — file-aware
 *     truncation for staged/unstaged git diffs. Keeps the largest file
 *     chunks within the budget (most semantic signal) and lists the
 *     omitted files in a footer. The caller injects `splitDiffByFile`
 *     so this module stays free of a `lib/git.js` dependency.
 *
 *   - `truncateText(text, { maxBytes })` — raw slice cap for opaque
 *     blobs (CHANGELOG content, freeform notes) where no file structure
 *     exists. Returns the prefix and a `truncated` flag.
 *
 * Defaults: `truncateDiff` uses 8000 (commit.js's historical value);
 * `truncateText` uses no default — callers must supply `maxBytes`
 * because the right cap is content-specific.
 *
 * NOTE on units: `maxBytes` is a historical name retained for API
 * stability. The cap is enforced against `String.length`, which counts
 * UTF-16 code units rather than bytes — a string with non-BMP
 * characters (e.g. emoji) will use 2 code units per character but
 * encode to 4 UTF-8 bytes. For ASCII-dominant inputs (the typical
 * staged diff and CHANGELOG case) the difference is negligible. If a
 * caller needs a true byte budget, measure with `Buffer.byteLength`
 * before calling.
 *
 * Issue #284, task 20 — replaces the file-aware copy in commit.js
 * and the two raw `slice(0, 5000)` sites in version.js.
 */

const DEFAULT_DIFF_MAX_BYTES = 8000;

const LOCKFILE_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
const LOCKFILE_EXCLUDED_MARKER = '# [LOCKFILE EXCLUDED - SEE --STAT SUMMARY]';
const DIFF_ELLIPSIS = ' ...';

/**
 * File-aware diff truncation. The caller MUST inject
 * `splitDiffByFile(diff) -> Map<filePath, chunkText>` (typically
 * `require('./git').splitDiffByFile`) so this module avoids a circular
 * `lib/git.js` import.
 *
 * Behaviour preserved from the original `commit.js::truncateStagedDiff`:
 * - returns `{ diff, diffTruncated, truncatedFiles }`
 * - sorts file chunks largest-first to keep the highest-signal files
 * - always includes at least one chunk even if it exceeds the budget
 * - emits a `# --- Truncated ---` footer listing omitted files
 *
 * @param {string} fullDiff
 * @param {object} opts
 * @param {Function} opts.splitDiffByFile  Injected splitter (Map<file, chunk>)
 * @param {number}  [opts.maxBytes=8000]  Cap measured in UTF-16 code units (`String.length`), not bytes — see module header.
 * @returns {{ diff: string, diffTruncated: boolean, truncatedFiles: string[] }}
 */
function truncateDiff(fullDiff, { splitDiffByFile, maxBytes = DEFAULT_DIFF_MAX_BYTES } = {}) {
  if (typeof splitDiffByFile !== 'function') {
    throw new Error('truncateDiff: opts.splitDiffByFile is required');
  }

  if (fullDiff.length <= maxBytes) {
    return { diff: fullDiff, diffTruncated: false, truncatedFiles: [] };
  }

  const fileChunks = splitDiffByFile(fullDiff);

  // Guard: if the diff doesn't parse into per-file chunks, return the original
  // unchanged. Must run before any code below derives `currentDiff` from
  // `fileChunks` — an empty Map joins to `''`, which is `<= maxBytes` and would
  // otherwise trigger an early return of an empty diff instead of this fallback.
  if (fileChunks.size === 0) {
    return { diff: fullDiff, diffTruncated: false, truncatedFiles: [] };
  }

  // 1. Lockfile Exclusions
  let lockfilesExcluded = false;
  for (const [filePath, chunk] of fileChunks.entries()) {
    if (LOCKFILE_NAMES.some(name => filePath.endsWith(name))) {
      fileChunks.set(filePath, `diff --git a/${filePath} b/${filePath}\n${LOCKFILE_EXCLUDED_MARKER}`);
      lockfilesExcluded = true;
    }
  }

  let currentDiff = Array.from(fileChunks.values()).join('');
  if (currentDiff.length <= maxBytes) {
    return { diff: currentDiff, diffTruncated: lockfilesExcluded, truncatedFiles: [] };
  }

  // 2. Diff-Hunk Budgeting (Context Reduction - pseudo -U1)
  let contextReduced = false;
  for (const [filePath, chunk] of fileChunks.entries()) {
    if (chunk.includes(LOCKFILE_EXCLUDED_MARKER)) continue;
    
    const lines = chunk.split('\n');
    const reducedLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith(' ') && !line.startsWith(' +') && !line.startsWith(' -')) {
        // Unchanged line
        const prev = i > 0 ? lines[i-1] : '';
        const next = i < lines.length - 1 ? lines[i+1] : '';
        const prevIsChange = prev.startsWith('+') || prev.startsWith('-');
        const nextIsChange = next.startsWith('+') || next.startsWith('-');
        const isHeader = prev.startsWith('@@') || next.startsWith('@@');
        
        if (prevIsChange || nextIsChange || isHeader) {
          reducedLines.push(line);
        } else if (reducedLines.length > 0 && reducedLines[reducedLines.length - 1] !== DIFF_ELLIPSIS) {
          reducedLines.push(DIFF_ELLIPSIS);
        }
      } else {
        reducedLines.push(line);
      }
    }
    const reducedChunk = reducedLines.join('\n');
    if (reducedChunk.length < chunk.length) {
      fileChunks.set(filePath, reducedChunk);
      contextReduced = true;
    }
  }

  currentDiff = Array.from(fileChunks.values()).join('');
  if (currentDiff.length <= maxBytes) {
    return { diff: currentDiff, diffTruncated: true, truncatedFiles: [] };
  }

  // Sort descending by chunk size (largest first — most signal)
  const sorted = [...fileChunks.entries()].sort((a, b) => b[1].length - a[1].length);

  const included = [];
  const truncatedFiles = [];
  let totalChars = 0;

  for (const [filePath, chunk] of sorted) {
    if (included.length === 0) {
      // Always include at least one file
      included.push(chunk);
      totalChars += chunk.length;
    } else if (totalChars + chunk.length <= maxBytes) {
      included.push(chunk);
      totalChars += chunk.length;
    } else {
      truncatedFiles.push(filePath);
    }
  }

  const footer = [
    `# --- Truncated ---`,
    `# The following ${truncatedFiles.length} file(s) were omitted (see diffStat for summary):`,
    ...truncatedFiles.map(f => `# - ${f}`),
  ].join('\n');

  const diff = included.join('') + '\n' + footer;
  return { diff, diffTruncated: true, truncatedFiles };
}

/**
 * Raw-byte truncation for opaque text. Used by version.js for CHANGELOG
 * content, where no file structure exists to be preserved.
 *
 * Behaviour preserved from version.js:
 *   `text.length > maxBytes ? text.slice(0, maxBytes) : text`
 *
 * @param {string} text
 * @param {object} opts
 * @param {number} opts.maxBytes  Required. Cap measured in UTF-16 code units (`String.length`), not bytes — see module header.
 * @returns {{ text: string, truncated: boolean }}
 */
function truncateText(text, { maxBytes } = {}) {
  if (typeof maxBytes !== 'number' || maxBytes < 0) {
    throw new Error('truncateText: opts.maxBytes (non-negative number) is required');
  }
  if (text.length <= maxBytes) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxBytes), truncated: true };
}

module.exports = { truncateDiff, truncateText, DEFAULT_DIFF_MAX_BYTES };
