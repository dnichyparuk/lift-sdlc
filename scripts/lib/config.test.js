'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  readSection,
  writeSection,
  ensureSdlcGitignore,
  PROJECT_SECTIONS,
} = require('./config');

const REPO_ROOT = path.join(__dirname, '..', '..');

function mkTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
}

function initGitRepo(dir) {
  const result = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git init failed: ${result.stderr}`);
}

/** Returns true if `relPath` (relative to `cwd`) is ignored per git's own rules. */
function isGitIgnored(cwd, relPath) {
  const result = spawnSync('git', ['check-ignore', relPath], { cwd, encoding: 'utf8' });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git check-ignore failed unexpectedly (status ${result.status}): ${result.stderr}`);
}

// ---------------------------------------------------------------------------
// R2 — new PROJECT_SECTIONS entries resolve via readSection/writeSection
// ---------------------------------------------------------------------------

test('PROJECT_SECTIONS includes rejected_guardrails and learn', () => {
  assert.ok(PROJECT_SECTIONS.has('rejected_guardrails'));
  assert.ok(PROJECT_SECTIONS.has('learn'));
});

test('readSection resolves "rejected_guardrails" as a flat array of signature strings, not falling through as unknown', () => {
  const root = mkTempProject();
  try {
    const signatures = ['auth-layer-raw-sql', 'missing-null-check'];
    writeSection(root, 'rejected_guardrails', signatures);

    const result = readSection(root, 'rejected_guardrails');
    assert.deepStrictEqual(result, signatures);
    assert.ok(Array.isArray(result));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSection resolves "learn" instead of falling through as unknown', () => {
  const root = mkTempProject();
  try {
    const learnConfig = { enabled: true };
    writeSection(root, 'learn', learnConfig);

    const result = readSection(root, 'learn');
    assert.deepStrictEqual(result, learnConfig);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSection returns null for "rejected_guardrails" / "learn" when the section is absent (no config.json written)', () => {
  const root = mkTempProject();
  try {
    assert.strictEqual(readSection(root, 'rejected_guardrails'), null);
    assert.strictEqual(readSection(root, 'learn'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R1 — ensureSdlcGitignore un-ignores learnings/pending/** while keeping the
// rest of .sdlc/learnings/ ignored
// ---------------------------------------------------------------------------

test('ensureSdlcGitignore: learnings/pending/** is NOT ignored, learnings/log.md stays ignored', () => {
  const root = mkTempProject();
  try {
    initGitRepo(root);
    ensureSdlcGitignore(root);

    assert.strictEqual(
      isGitIgnored(root, path.join('.sdlc', 'learnings', 'pending', 'x.md')),
      false,
      '.sdlc/learnings/pending/x.md should NOT be ignored'
    );
    assert.strictEqual(
      isGitIgnored(root, path.join('.sdlc', 'learnings', 'log.md')),
      true,
      '.sdlc/learnings/log.md should stay ignored'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Idempotency (fresh file) + negation ordering
// ---------------------------------------------------------------------------

test('ensureSdlcGitignore: re-running twice is idempotent and preserves the three new negations, in order after "*"', () => {
  const root = mkTempProject();
  try {
    const first = ensureSdlcGitignore(root);
    assert.strictEqual(first, 'created');

    const second = ensureSdlcGitignore(root);
    assert.strictEqual(second, 'unchanged');

    const content = fs.readFileSync(path.join(root, '.sdlc', '.gitignore'), 'utf8');
    const lines = content.split('\n');

    const starIdx = lines.indexOf('*');
    const learningsIdx = lines.indexOf('!learnings/');
    const pendingDirIdx = lines.indexOf('!learnings/pending/');
    const pendingGlobIdx = lines.indexOf('!learnings/pending/**');

    assert.ok(starIdx >= 0, '"*" pattern must be present');
    assert.ok(learningsIdx > starIdx, '!learnings/ must come after "*"');
    assert.ok(pendingDirIdx > starIdx, '!learnings/pending/ must come after "*"');
    assert.ok(pendingGlobIdx > starIdx, '!learnings/pending/** must come after "*"');
    // Order among the three new negations themselves, as declared in the array.
    assert.ok(learningsIdx < pendingDirIdx);
    assert.ok(pendingDirIdx < pendingGlobIdx);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Idempotency against this repo's actual, currently-in-use .sdlc/.gitignore
// fixture (two managed blocks: "lift-sdlc managed" — owned by
// ensureSdlcGitignore — and "sdlc-utilities managed"). Copied verbatim at
// test-write time rather than hardcoded, since which block currently holds
// the live patterns can shift.
// ---------------------------------------------------------------------------

test('ensureSdlcGitignore: idempotent against this repo\'s real .sdlc/.gitignore fixture (two managed blocks)', () => {
  const realGitignorePath = path.join(REPO_ROOT, '.sdlc', '.gitignore');
  const realContent = fs.readFileSync(realGitignorePath, 'utf8');

  // Sanity: the fixture we're testing against actually carries both markers,
  // so this test exercises the two-block scenario it claims to.
  assert.ok(realContent.includes('lift-sdlc managed'), 'fixture must contain the lift-sdlc managed marker');
  assert.ok(realContent.includes('sdlc-utilities managed'), 'fixture must contain the sdlc-utilities managed marker');

  const root = mkTempProject();
  try {
    fs.mkdirSync(path.join(root, '.sdlc'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sdlc', '.gitignore'), realContent, 'utf8');

    ensureSdlcGitignore(root);
    const afterFirst = fs.readFileSync(path.join(root, '.sdlc', '.gitignore'), 'utf8');

    const second = ensureSdlcGitignore(root);
    const afterSecond = fs.readFileSync(path.join(root, '.sdlc', '.gitignore'), 'utf8');

    assert.strictEqual(second, 'unchanged');
    assert.strictEqual(afterFirst, afterSecond, 'a second run must not further mutate the file');

    // Both blocks' markers must still be present exactly once each — no
    // merging or orphaning of markers across the two managed blocks.
    const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;
    assert.strictEqual(countOccurrences(afterSecond, '# >>> lift-sdlc managed (do not edit) — selective ignores'), 1);
    assert.strictEqual(countOccurrences(afterSecond, '# <<< lift-sdlc managed'), 1);
    assert.strictEqual(countOccurrences(afterSecond, 'sdlc-utilities managed'), 2);

    // The three new negations are present in the rebuilt lift-sdlc block.
    assert.ok(afterSecond.includes('!learnings/\n'));
    assert.ok(afterSecond.includes('!learnings/pending/\n'));
    assert.ok(afterSecond.includes('!learnings/pending/**\n'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
