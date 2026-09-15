'use strict';

/**
 * token-line.js
 * Generic final-non-blank-line token scanner, shared by `wave-summary.js`
 * (WAVE_SUMMARY) and `verify-summary.js` (VERIFY_SUMMARY).
 *
 * Extracted out of `wave-summary.js` (previously the sole owner of
 * `extractFinalLineToken`) so that same-layer `lib/` modules don't need to
 * cross-import a generic string-parsing helper from a module about wave
 * execution. `wave-summary.js` re-exports this function for backward
 * compatibility with existing importers/tests.
 *
 * No I/O. Zero npm dependencies.
 */

/**
 * Scan text for a token on its final non-blank line.
 *
 * The final non-empty line (after trimming trailing whitespace per-line)
 * is the only line inspected — a matching prefix earlier in the text does
 * not count if a non-blank line follows it.
 *
 * @param {unknown} text   - candidate text; non-strings never match
 * @param {string} prefix  - required prefix on the final non-blank line
 * @returns {{ found: boolean, payload: string|null }}
 */
function extractFinalLineToken(text, prefix) {
  if (typeof text !== 'string') return { found: false, payload: null };

  const lines = text.split('\n').map(l => l.trimEnd());
  let tokenLine = null;

  // Scan from end, skip blank lines, find first non-blank line
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (line.startsWith(prefix)) {
      tokenLine = line;
    }
    break; // only check the final non-blank line
  }

  if (!tokenLine) return { found: false, payload: null };

  return { found: true, payload: tokenLine.slice(prefix.length).trim() };
}

module.exports = { extractFinalLineToken };
