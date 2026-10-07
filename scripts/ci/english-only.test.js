'use strict';

/**
 * English-only guard.
 *
 * The plugin is English-only: no git-tracked file may contain Cyrillic
 * characters (U+0400–U+04FF). A file may be exempted only when the Cyrillic
 * text is really needed (for example, test data that checks non-ASCII
 * handling). Every exemption is listed in ALLOWED_FILES with its reason; an
 * exemption that no longer matches anything fails the test, so the list
 * cannot go stale.
 *
 * This file itself spells the range with escapes so that it stays clean.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const CYRILLIC = /[\u0400-\u04FF]/;

/**
 * Files allowed to contain Cyrillic, as repo-relative POSIX paths mapped to
 * the reason. Keep it empty unless a file truly needs Cyrillic text.
 * @type {Record<string, string>}
 */
const ALLOWED_FILES = {};

/**
 * Find the lines of `text` that contain Cyrillic characters.
 * @param {string} text
 * @returns {{ line: number, column: number, snippet: string }[]}
 */
function findCyrillic(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = CYRILLIC.exec(lines[i]);
    if (m) {
      const snippet = lines[i].trim();
      hits.push({
        line: i + 1,
        column: m.index + 1,
        snippet: snippet.length > 120 ? `${snippet.slice(0, 117)}...` : snippet,
      });
    }
  }
  return hits;
}

/** @returns {string[] | null} tracked files, or null when git is unavailable */
function listTrackedFiles() {
  const res = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (res.error || res.status !== 0) return null;
  return res.stdout.split('\0').filter(Boolean);
}

/**
 * Scan tracked files and return every Cyrillic hit outside ALLOWED_FILES,
 * plus the files that do contain Cyrillic (for the stale-exemption check).
 */
function scanRepo(files) {
  const violations = [];
  const filesWithCyrillic = new Set();
  for (const rel of files) {
    const abs = path.join(REPO_ROOT, rel);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue; // deleted in the working tree but still in the index
    }
    if (buf.includes(0)) continue; // binary file
    const hits = findCyrillic(buf.toString('utf8'));
    if (hits.length === 0) continue;
    filesWithCyrillic.add(rel);
    if (Object.prototype.hasOwnProperty.call(ALLOWED_FILES, rel)) continue;
    for (const h of hits) violations.push(`${rel}:${h.line}:${h.column}: ${h.snippet}`);
  }
  return { violations, filesWithCyrillic };
}

describe('english-only guard', () => {
  test('findCyrillic reports line and column', () => {
    const word = String.fromCharCode(0x043f, 0x043b, 0x0430, 0x043d); // a Cyrillic word
    const hits = findCyrillic(`# Title\nplain line\nsee ${word} here\r\nend`);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 3);
    assert.equal(hits[0].column, 5);
  });

  test('findCyrillic covers the whole U+0400-U+04FF range and nothing outside it', () => {
    assert.equal(findCyrillic(String.fromCharCode(0x0400)).length, 1);
    assert.equal(findCyrillic(String.fromCharCode(0x04ff)).length, 1);
    assert.equal(findCyrillic(String.fromCharCode(0x03ff, 0x0500) + ' café — ✓').length, 0);
  });

  test('every ALLOWED_FILES entry has a reason', () => {
    for (const [file, reason] of Object.entries(ALLOWED_FILES)) {
      assert.ok(typeof reason === 'string' && reason.trim().length > 0, `${file}: exemption needs a reason`);
    }
  });

  test('git-tracked files contain no Cyrillic outside the exemptions', (t) => {
    const files = listTrackedFiles();
    if (files === null) {
      t.skip('not a git checkout (or git is unavailable): nothing to scan');
      return;
    }
    const { violations, filesWithCyrillic } = scanRepo(files);
    assert.deepEqual(
      violations,
      [],
      `Cyrillic text found (the plugin must be English-only). Translate it, or add the file to ` +
        `ALLOWED_FILES in scripts/ci/english-only.test.js with a reason:\n  ${violations.join('\n  ')}`
    );

    const stale = Object.keys(ALLOWED_FILES).filter((f) => !filesWithCyrillic.has(f));
    assert.deepEqual(stale, [], `ALLOWED_FILES entries with no Cyrillic left (remove them):\n  ${stale.join('\n  ')}`);
  });
});
