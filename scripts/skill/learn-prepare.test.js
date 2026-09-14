'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'learn-prepare.js');
const PENDING_DIR = path.join('.sdlc', 'learnings', 'pending');

// ---------------------------------------------------------------------------
// Hermetic fixture: a work repo with a local bare `origin` — every git call
// the script makes (fetch included) stays on the filesystem, no network.
// ---------------------------------------------------------------------------

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function gitAllowFail(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * @param {object} [opts]
 * @param {object|null} [opts.originConfig] — .sdlc/config.json committed and pushed to origin/main
 * @param {object|null} [opts.localConfig]  — .sdlc/config.json committed on a local-only branch
 * @param {Record<string,string>} [opts.pending] — filename -> content, left UNTRACKED
 */
function mkRepo(opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-prepare-'));
  const originPath = path.join(base, 'origin.git');
  const work = path.join(base, 'work');

  git(base, ['init', '--bare', '-q', '--initial-branch=main', originPath]);
  fs.mkdirSync(work);
  git(work, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'Test']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['checkout', '-q', '-b', 'main']);

  fs.writeFileSync(path.join(work, 'README.md'), '# fixture\n');
  git(work, ['add', 'README.md']);
  git(work, ['commit', '-q', '-m', 'initial']);

  if (opts.originConfig) {
    writeConfig(work, opts.originConfig);
    git(work, ['add', '-f', '.sdlc/config.json']);
    git(work, ['commit', '-q', '-m', 'add config']);
  }

  git(work, ['remote', 'add', 'origin', originPath]);
  git(work, ['push', '-q', 'origin', 'main']);
  git(work, ['fetch', '-q', 'origin', 'main']);

  if (opts.localConfig) {
    // Committed locally and never pushed: origin/main does NOT see it.
    git(work, ['checkout', '-q', '-b', 'feat/local']);
    writeConfig(work, opts.localConfig);
    git(work, ['add', '-f', '.sdlc/config.json']);
    git(work, ['commit', '-q', '-m', 'local-only config']);
  }

  for (const [name, content] of Object.entries(opts.pending || {})) {
    const dir = path.join(work, PENDING_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }

  return { base, work };
}

function writeConfig(work, config) {
  fs.mkdirSync(path.join(work, '.sdlc'), { recursive: true });
  fs.writeFileSync(path.join(work, '.sdlc', 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

function changeset(signature, impact) {
  const lines = ['---', `signature: ${signature}`, 'rationale: repeated failure', 'evidence: incident log'];
  if (impact) lines.push(`impact: ${impact}`);
  lines.push('---', '', 'body', '');
  return lines.join('\n');
}

/** Three corroborating changesets for one signature. */
function trio(signature, impact) {
  return {
    [`1-${signature}.md`]: changeset(signature),
    [`2-${signature}.md`]: changeset(signature, impact),
    [`3-${signature}.md`]: changeset(signature),
  };
}

function run(work, args = []) {
  const result = spawnSync('node', [SCRIPT, ...args], { cwd: work, encoding: 'utf8' });
  let manifest = null;
  const printed = result.stdout.trim();
  if (printed.endsWith('.json') && fs.existsSync(printed)) {
    manifest = JSON.parse(fs.readFileSync(printed, 'utf8'));
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, manifest, printed };
}

function assimilationBranches(work) {
  const out = gitAllowFail(work, ['branch', '--list', 'sdlc/assimilation-*']);
  return out.stdout.split('\n').map(l => l.replace(/^[*+ ]+/, '').trim()).filter(Boolean);
}

function withRepo(opts, fn) {
  const repo = mkRepo(opts);
  try {
    fn(repo);
  } finally {
    fs.rmSync(repo.base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// R7 / R9 — no-op runs
// ---------------------------------------------------------------------------

test('R7: no pending directory — exit 0, empty manifest, no branch', () => {
  withRepo({}, ({ work }) => {
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 0);
    assert.match(r.printed, /sdlc-learn-[0-9a-f]{8}\.json$/); // R9
    assert.deepStrictEqual(r.manifest.eligible, []);
    assert.deepStrictEqual(r.manifest.waiting, []);
    assert.deepStrictEqual(r.manifest.skipped, []);
    assert.strictEqual(r.manifest.branchName, null);
    assert.strictEqual(r.manifest.defaultBranch, 'main');
    assert.strictEqual(r.manifest.initialBranch, 'main');
    assert.deepStrictEqual(r.manifest.errors, []);
    assert.deepStrictEqual(assimilationBranches(work), []);
  });
});

test('non-ENOENT failure reading the pending directory is fatal — exit 1 with the error surfaced (test-coverage-review)', () => {
  withRepo({}, ({ work }) => {
    // Force a non-ENOENT fs.readdirSync error that is filesystem/permission-
    // agnostic (unlike chmod, which some filesystems/CI users don't enforce):
    // put a plain FILE where PENDING_DIR expects a directory, so readdirSync
    // throws ENOTDIR rather than ENOENT.
    const learningsDir = path.join(work, '.sdlc', 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.writeFileSync(path.join(learningsDir, 'pending'), 'not a directory');

    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /cannot read \.sdlc\/learnings\/pending/);
    assert.ok(r.manifest, 'exit-1 fatal path still writes a manifest via writeOutput');
    assert.strictEqual(r.manifest.errors.length, 1);
    assert.match(r.manifest.errors[0], /cannot read \.sdlc\/learnings\/pending/);
  });
});

test('R7 short-circuit: zero parseable changesets skips the fetch entirely', () => {
  withRepo({}, ({ work }) => {
    // No remote at all — a run that fetched would fail; the short-circuit means
    // it never does.
    git(work, ['remote', 'remove', 'origin']);
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(r.manifest.errors, []);
    // Fail-closed: no pre-image was captured on a no-op run.
    assert.strictEqual(r.manifest.preImageStatus, 'error');
    assert.deepStrictEqual(r.manifest.preImage, {});
  });
});

test('R4: malformed changesets are excluded and logged in skipped[]', () => {
  withRepo({ pending: { 'bad.md': 'no frontmatter here\n', 'worse.md': '---\nsignature: ok-sig\n---\n' } }, ({ work }) => {
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(r.manifest.eligible, []);
    assert.strictEqual(r.manifest.skipped.length, 2);
    const bad = r.manifest.skipped.find(s => s.filePath === '.sdlc/learnings/pending/bad.md');
    assert.match(bad.reason, /frontmatter/i);
    const worse = r.manifest.skipped.find(s => s.filePath === '.sdlc/learnings/pending/worse.md');
    assert.match(worse.reason, /rationale/);
    assert.deepStrictEqual(assimilationBranches(work), []);
  });
});

test('R6/R7: below-threshold signatures land in waiting[] and create no branch', () => {
  const pending = {
    'a.md': changeset('flaky-timer-test'),
    'b.md': changeset('flaky-timer-test'),
  };
  withRepo({ pending }, ({ work }) => {
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(r.manifest.eligible, []);
    assert.deepStrictEqual(r.manifest.waiting, [{ signature: 'flaky-timer-test', count: 2 }]);
    assert.strictEqual(r.manifest.branchName, null);
    assert.deepStrictEqual(assimilationBranches(work), []);
  });
});

// ---------------------------------------------------------------------------
// Happy path — eligibility, pre-image, branch
// ---------------------------------------------------------------------------

test('eligible signature: absent pre-image, branch created off origin/main', () => {
  withRepo({ pending: trio('auth-layer-raw-sql', 'low-revert-cost') }, ({ work }) => {
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(r.manifest.errors, []);
    // R8 — ls-tree-first classification: the path genuinely does not exist.
    assert.strictEqual(r.manifest.preImageStatus, 'absent');
    assert.deepStrictEqual(r.manifest.preImage, {});
    assert.deepStrictEqual(r.manifest.eligible, [{
      signature: 'auth-layer-raw-sql',
      files: [
        '.sdlc/learnings/pending/1-auth-layer-raw-sql.md',
        '.sdlc/learnings/pending/2-auth-layer-raw-sql.md',
        '.sdlc/learnings/pending/3-auth-layer-raw-sql.md',
      ],
      impact: 'low-revert-cost',
    }]);
    assert.match(r.manifest.branchName, /^sdlc\/assimilation-\d+$/);
    assert.strictEqual(r.manifest.initialBranch, 'main');
    // Branch exists and is checked out; it points at origin/main.
    assert.deepStrictEqual(assimilationBranches(work), [r.manifest.branchName]);
    assert.strictEqual(git(work, ['rev-parse', '--abbrev-ref', 'HEAD']), r.manifest.branchName);
    assert.strictEqual(
      git(work, ['rev-parse', 'HEAD']),
      git(work, ['rev-parse', 'origin/main'])
    );
    // Pending files stay untracked — never staged or committed by this script.
    const staged = git(work, ['status', '--porcelain', '--untracked-files=all']);
    assert.match(staged, /^\?\? \.sdlc\/learnings\/pending\/1-auth-layer-raw-sql\.md$/m);
  });
});

test('resolved pre-image: full origin/main config captured verbatim', () => {
  const originConfig = {
    plan: { guardrails: [{ id: 'g1', description: 'd', severity: 'high' }] },
    execute: { guardrails: [] },
    rejected_guardrails: [],
    learn: { recurrenceThreshold: 3, staleAfterCycles: null },
  };
  withRepo({ originConfig, pending: trio('auth-layer-raw-sql') }, ({ work }) => {
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.manifest.preImageStatus, 'resolved');
    assert.deepStrictEqual(r.manifest.preImage, originConfig);
    assert.strictEqual(r.manifest.eligible.length, 1);
    assert.strictEqual(r.manifest.eligible[0].impact, null);
  });
});

test('R6: recurrenceThreshold from the learn section is threaded into selectEligible', () => {
  const originConfig = { learn: { recurrenceThreshold: 2, staleAfterCycles: null } };
  const pending = { 'a.md': changeset('two-is-enough'), 'b.md': changeset('two-is-enough') };
  withRepo({ originConfig, pending }, ({ work }) => {
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(r.manifest.waiting, []);
    assert.strictEqual(r.manifest.eligible.length, 1);
    assert.strictEqual(r.manifest.eligible[0].signature, 'two-is-enough');
  });
});

for (const invalidThreshold of [0, -1, 'not-a-number']) {
  test(`resolveThreshold: an invalid recurrenceThreshold (${JSON.stringify(invalidThreshold)}) falls back to the default of 3 (test-coverage-review)`, () => {
    const originConfig = { learn: { recurrenceThreshold: invalidThreshold, staleAfterCycles: null } };
    // Exactly 2 changesets: if the invalid value were used as-is (e.g. 0 or -1,
    // which any count satisfies), this signature would wrongly become eligible
    // immediately. With the correct fallback to DEFAULT_THRESHOLD (3), 2 is not
    // enough — it must land in `waiting`, not `eligible`.
    const pending = { 'a.md': changeset('needs-default-threshold'), 'b.md': changeset('needs-default-threshold') };
    withRepo({ originConfig, pending }, ({ work }) => {
      const r = run(work, ['--default-branch', 'main']);
      assert.strictEqual(r.status, 0);
      assert.deepStrictEqual(r.manifest.eligible, []);
      assert.strictEqual(r.manifest.waiting.length, 1);
      assert.strictEqual(r.manifest.waiting[0].signature, 'needs-default-threshold');
      assert.strictEqual(r.manifest.waiting[0].count, 2);
    });
  });
}

// ---------------------------------------------------------------------------
// R5 — rejected signatures come from the pre-image, not the local tree
// ---------------------------------------------------------------------------

test('R5: signatures rejected on origin/main are suppressed', () => {
  const originConfig = { rejected_guardrails: ['auth-layer-raw-sql'] };
  const pending = { ...trio('auth-layer-raw-sql'), ...trio('flaky-timer-test') };
  withRepo({ originConfig, pending }, ({ work }) => {
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(r.manifest.eligible.map(e => e.signature), ['flaky-timer-test']);
    const suppressed = r.manifest.skipped.filter(s => /rejected_guardrails/.test(s.reason));
    assert.strictEqual(suppressed.length, 3);
    assert.match(suppressed[0].filePath, /auth-layer-raw-sql\.md$/);
  });
});

test('R5: a rejection present only in the local working tree does NOT suppress', () => {
  // origin/main has an empty rejected list; a local-only commit adds one.
  // The local read must be ignored — the pre-image is the only source.
  const originConfig = { rejected_guardrails: [] };
  const localConfig  = { rejected_guardrails: ['auth-layer-raw-sql'] };
  withRepo({ originConfig, localConfig, pending: trio('auth-layer-raw-sql') }, ({ work }) => {
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.manifest.initialBranch, 'feat/local');
    assert.deepStrictEqual(r.manifest.preImage, originConfig);
    assert.deepStrictEqual(r.manifest.eligible.map(e => e.signature), ['auth-layer-raw-sql']);
    assert.deepStrictEqual(r.manifest.skipped, []);
  });
});

// ---------------------------------------------------------------------------
// R8 — clean-tree precondition (exactly two checks)
// ---------------------------------------------------------------------------

test('R8: tracked-file modification exits 1 and creates no branch', () => {
  withRepo({ pending: trio('auth-layer-raw-sql') }, ({ work }) => {
    fs.writeFileSync(path.join(work, 'README.md'), '# edited\n');
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 1);
    assert.match(r.manifest.errors.join('\n'), /tracked files with uncommitted changes: README\.md/);
    assert.strictEqual(r.manifest.branchName, null);
    assert.deepStrictEqual(assimilationBranches(work), []);
  });
});

test('R8: untracked entry outside the pending directory exits 1', () => {
  withRepo({ pending: trio('auth-layer-raw-sql') }, ({ work }) => {
    fs.writeFileSync(path.join(work, 'stray.txt'), 'leftover\n');
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 1);
    assert.match(r.manifest.errors.join('\n'), /untracked entries outside \.sdlc\/learnings\/pending\/: stray\.txt/);
    assert.deepStrictEqual(assimilationBranches(work), []);
  });
});

test('R8: untracked pending files alone never fail the clean-tree check', () => {
  withRepo({ pending: trio('auth-layer-raw-sql') }, ({ work }) => {
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(r.manifest.errors, []);
  });
});

test('R8: an UNTRACKED .sdlc/config.json aborts before createBranch', () => {
  withRepo({ pending: trio('auth-layer-raw-sql') }, ({ work }) => {
    writeConfig(work, { plan: { guardrails: [] } });
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 1);
    assert.match(r.manifest.errors.join('\n'), /\.sdlc\/config\.json exists as an UNTRACKED file/);
    assert.strictEqual(r.manifest.branchName, null);
    assert.deepStrictEqual(assimilationBranches(work), []);
  });
});

test('R8: a tracked .sdlc/config.json passes the untracked-config check', () => {
  const originConfig = { rejected_guardrails: [] };
  withRepo({ originConfig, pending: trio('auth-layer-raw-sql') }, ({ work }) => {
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(r.manifest.errors, []);
    assert.strictEqual(r.manifest.preImageStatus, 'resolved');
  });
});

// ---------------------------------------------------------------------------
// R8 — fetch-first, and the fail-closed 'error' classification
// ---------------------------------------------------------------------------

test('R8: a failing fetch aborts with exit 1 before any branch is created', () => {
  withRepo({ pending: trio('auth-layer-raw-sql') }, ({ work }) => {
    const r = run(work, ['--default-branch', 'does-not-exist']);
    assert.strictEqual(r.status, 1);
    assert.match(r.manifest.errors.join('\n'), /git fetch origin does-not-exist failed/);
    assert.strictEqual(r.manifest.preImageStatus, 'error');
    assert.strictEqual(r.manifest.branchName, null);
    assert.deepStrictEqual(assimilationBranches(work), []);
  });
});

test("R8: an unresolvable origin/<default> classifies preImageStatus 'error' and aborts", () => {
  withRepo({ originConfig: { plan: { guardrails: [] } }, pending: trio('auth-layer-raw-sql') }, ({ work }) => {
    // Drop the remote-tracking ref and its refspec: `git fetch origin main`
    // still succeeds (FETCH_HEAD only), but origin/main no longer resolves —
    // exactly the ls-tree-fails case that must NOT be read as 'absent'.
    git(work, ['config', '--unset', 'remote.origin.fetch']);
    git(work, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.manifest.preImageStatus, 'error');
    assert.deepStrictEqual(r.manifest.preImage, {});
    assert.match(r.manifest.errors.join('\n'), /cannot resolve origin\/main/);
    assert.strictEqual(r.manifest.branchName, null);
    assert.deepStrictEqual(assimilationBranches(work), []);
  });
});

test("R8: a malformed origin/<default> config classifies 'error' rather than crashing", () => {
  withRepo({ pending: trio('auth-layer-raw-sql') }, ({ work }) => {
    fs.mkdirSync(path.join(work, '.sdlc'), { recursive: true });
    fs.writeFileSync(path.join(work, '.sdlc', 'config.json'), '{ not json\n');
    git(work, ['add', '-f', '.sdlc/config.json']);
    git(work, ['commit', '-q', '-m', 'broken config']);
    git(work, ['push', '-q', 'origin', 'main']);
    const r = run(work, ['--default-branch', 'main']);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.manifest.preImageStatus, 'error');
    assert.match(r.manifest.errors.join('\n'), /not valid JSON/);
    assert.deepStrictEqual(assimilationBranches(work), []);
  });
});
