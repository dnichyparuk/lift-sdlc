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
  writeLocalSection,
  ensureSdlcGitignore,
  PROJECT_SECTIONS,
  LOCAL_SECTIONS,
  DUAL_SECTIONS,
  PROJECT_SCHEMA_URL,
  LOCAL_SCHEMA_URL,
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

// ---------------------------------------------------------------------------
// Phase 2 Task 2 — dual-file `execute` precedence, deep-merge, and local write
// ---------------------------------------------------------------------------

function writeRawJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

test('DUAL_SECTIONS includes execute while PROJECT_SECTIONS retains execute', () => {
  assert.ok(PROJECT_SECTIONS.has('execute'));
  assert.ok(DUAL_SECTIONS.has('execute'));
  assert.ok(LOCAL_SECTIONS.has('ship'));
});

test('readSection(root, "execute") returns null when absent in both files', () => {
  const root = mkTempProject();
  try {
    assert.strictEqual(readSection(root, 'execute'), null);

    // Also returns null when both config files exist but neither defines execute.
    writeRawJson(path.join(root, '.sdlc', 'config.json'), { schemaVersion: 4, plan: { guardrails: [] } });
    writeRawJson(path.join(root, '.sdlc', 'local.json'), { schemaVersion: 4, ship: { auto: true } });
    assert.strictEqual(readSection(root, 'execute'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSection(root, "execute") reads project-only execute configuration', () => {
  const root = mkTempProject();
  try {
    const projectExecute = {
      guardrails: [{ id: 'no-raw-sql', description: 'Use parameterized queries', severity: 'error' }],
      standardWorkerEnum: 'pro',
      priorWaveContextCaps: { maxFiles: 20, maxDecisions: 10, maxInterfaces: 15 },
    };
    writeRawJson(path.join(root, '.sdlc', 'config.json'), {
      schemaVersion: 4,
      execute: projectExecute,
    });

    assert.deepStrictEqual(readSection(root, 'execute'), projectExecute);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSection(root, "execute") reads local-only execute configuration', () => {
  const root = mkTempProject();
  try {
    const localExecute = {
      standardWorkerEnum: 'inherit',
      priorWaveContextCaps: { maxFiles: 12 },
    };
    writeRawJson(path.join(root, '.sdlc', 'local.json'), {
      schemaVersion: 4,
      execute: localExecute,
    });

    assert.deepStrictEqual(readSection(root, 'execute'), localExecute);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSection(root, "execute") merges local overrides and deep-merges priorWaveContextCaps while preserving guardrails[]', () => {
  const root = mkTempProject();
  try {
    const guardrails = [
      { id: 'no-console-log', description: 'Avoid console.log in production code', severity: 'warning' },
    ];
    writeRawJson(path.join(root, '.sdlc', 'config.json'), {
      schemaVersion: 4,
      execute: {
        guardrails,
        standardWorkerEnum: 'pro',
        priorWaveContextCaps: {
          maxFiles: 20,
          maxDecisions: 10,
          maxInterfaces: 15,
        },
      },
    });
    writeRawJson(path.join(root, '.sdlc', 'local.json'), {
      schemaVersion: 4,
      execute: {
        standardWorkerEnum: 'inherit',
        priorWaveContextCaps: {
          maxFiles: 12,
        },
      },
    });

    const merged = readSection(root, 'execute');
    assert.deepStrictEqual(merged, {
      guardrails,
      standardWorkerEnum: 'inherit',
      priorWaveContextCaps: {
        maxFiles: 12,
        maxDecisions: 10,
        maxInterfaces: 15,
      },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSection(root, "execute") preserves project caps and guardrails when local only overrides standardWorkerEnum and omits priorWaveContextCaps', () => {
  const root = mkTempProject();
  try {
    const guardrails = [{ id: 'strict-types', description: 'Enforce strict typing', severity: 'error' }];
    writeRawJson(path.join(root, '.sdlc', 'config.json'), {
      schemaVersion: 4,
      execute: {
        guardrails,
        priorWaveContextCaps: { maxFiles: 20, maxDecisions: 10 },
      },
    });
    writeRawJson(path.join(root, '.sdlc', 'local.json'), {
      schemaVersion: 4,
      execute: {
        standardWorkerEnum: 'inherit',
      },
    });

    assert.deepStrictEqual(readSection(root, 'execute'), {
      guardrails,
      standardWorkerEnum: 'inherit',
      priorWaveContextCaps: { maxFiles: 20, maxDecisions: 10 },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSection(root, "execute") does not synthesize empty priorWaveContextCaps when absent in both files', () => {
  const root = mkTempProject();
  try {
    const guardrails = [{ id: 'g1', description: 'Check invariant', severity: 'error' }];
    writeRawJson(path.join(root, '.sdlc', 'config.json'), {
      schemaVersion: 4,
      execute: { guardrails },
    });
    writeRawJson(path.join(root, '.sdlc', 'local.json'), {
      schemaVersion: 4,
      execute: { standardWorkerEnum: 'inherit' },
    });

    const merged = readSection(root, 'execute');
    assert.deepStrictEqual(merged, {
      guardrails,
      standardWorkerEnum: 'inherit',
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(merged, 'priorWaveContextCaps'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeSection(root, "execute", data) preserves backwards-compatible write to .sdlc/config.json', () => {
  const root = mkTempProject();
  try {
    const projectExecute = {
      guardrails: [{ id: 'no-eval', description: 'Disallow eval', severity: 'error' }],
    };
    writeSection(root, 'execute', projectExecute);

    const projectPath = path.join(root, '.sdlc', 'config.json');
    const localPath = path.join(root, '.sdlc', 'local.json');
    assert.strictEqual(fs.existsSync(projectPath), true);
    assert.strictEqual(fs.existsSync(localPath), false);

    const written = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
    assert.strictEqual(written.$schema, PROJECT_SCHEMA_URL);
    assert.deepStrictEqual(written.execute, projectExecute);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeSection(root, "execute", data, { target: "local" }) writes .sdlc/local.json without creating or mutating .sdlc/config.json', () => {
  const root = mkTempProject();
  try {
    const localOverride = {
      standardWorkerEnum: 'inherit',
      priorWaveContextCaps: { maxFiles: 12 },
    };

    // Case 1: no .sdlc/config.json exists — must not be created.
    writeSection(root, 'execute', localOverride, { target: 'local' });
    const projectPath = path.join(root, '.sdlc', 'config.json');
    const localPath = path.join(root, '.sdlc', 'local.json');
    assert.strictEqual(fs.existsSync(projectPath), false);
    assert.strictEqual(fs.existsSync(localPath), true);

    const localData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    assert.strictEqual(localData.$schema, LOCAL_SCHEMA_URL);
    assert.deepStrictEqual(localData.execute, localOverride);

    // Case 2: existing .sdlc/config.json and sibling local sections must remain untouched.
    const initialProject = {
      $schema: PROJECT_SCHEMA_URL,
      schemaVersion: 4,
      execute: {
        guardrails: [{ id: 'g1', description: 'Keep project guardrails intact', severity: 'error' }],
        standardWorkerEnum: 'pro',
        priorWaveContextCaps: { maxFiles: 20, maxDecisions: 10 },
      },
    };
    writeRawJson(projectPath, initialProject);
    const beforeProjectBytes = fs.readFileSync(projectPath, 'utf8');

    writeSection(root, 'ship', { auto: true });
    writeSection(root, 'execute', { standardWorkerEnum: 'pro', priorWaveContextCaps: { maxFiles: 8 } }, { local: true });

    assert.strictEqual(fs.readFileSync(projectPath, 'utf8'), beforeProjectBytes);
    const updatedLocal = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    assert.strictEqual(updatedLocal.$schema, LOCAL_SCHEMA_URL);
    assert.deepStrictEqual(updatedLocal.ship, { auto: true });
    assert.deepStrictEqual(updatedLocal.execute, {
      standardWorkerEnum: 'pro',
      priorWaveContextCaps: { maxFiles: 8 },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeLocalSection writes local execute overrides without mutating .sdlc/config.json and rejects project-only sections', () => {
  const root = mkTempProject();
  try {
    const projectPath = path.join(root, '.sdlc', 'config.json');
    const localPath = path.join(root, '.sdlc', 'local.json');

    writeRawJson(projectPath, {
      $schema: PROJECT_SCHEMA_URL,
      schemaVersion: 4,
      execute: {
        guardrails: [{ id: 'g1', description: 'Keep me', severity: 'error' }],
        priorWaveContextCaps: { maxFiles: 20, maxDecisions: 10, maxInterfaces: 15 },
      },
    });
    const beforeProjectBytes = fs.readFileSync(projectPath, 'utf8');

    writeLocalSection(root, 'execute', {
      standardWorkerEnum: 'inherit',
      priorWaveContextCaps: { maxFiles: 12 },
    });

    assert.strictEqual(fs.readFileSync(projectPath, 'utf8'), beforeProjectBytes);
    const localData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    assert.strictEqual(localData.$schema, LOCAL_SCHEMA_URL);
    assert.deepStrictEqual(localData.execute, {
      standardWorkerEnum: 'inherit',
      priorWaveContextCaps: { maxFiles: 12 },
    });

    assert.deepStrictEqual(readSection(root, 'execute'), {
      guardrails: [{ id: 'g1', description: 'Keep me', severity: 'error' }],
      standardWorkerEnum: 'inherit',
      priorWaveContextCaps: { maxFiles: 12, maxDecisions: 10, maxInterfaces: 15 },
    });

    assert.throws(
      () => writeLocalSection(root, 'version', { mode: 'file' }),
      /cannot be written to local config/
    );
    assert.throws(
      () => writeSection(root, 'execute', {}, { target: 'invalid' }),
      /Invalid writeSection target/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
