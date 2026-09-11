'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'learn-apply.js');
const PENDING_DIR = path.join('.sdlc', 'learnings', 'pending');

const {
  fenceFor,
  renderPrBody,
  prTitle,
  commitMessage,
  deletePendingFiles,
  runShip,
  MANUAL_RECOVERY,
} = require(SCRIPT);

// ---------------------------------------------------------------------------
// Hermetic fixture: a work repo with a local bare `origin`. Every git call the
// script makes stays on the filesystem — no network, no real GitHub. `gh` is
// shadowed by a fake on PATH for the --ship end-to-end tests.
// ---------------------------------------------------------------------------

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function gitAllowFail(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function writeConfig(work, config) {
  fs.mkdirSync(path.join(work, '.sdlc'), { recursive: true });
  fs.writeFileSync(path.join(work, '.sdlc', 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

function changeset(signature) {
  return ['---', `signature: ${signature}`, 'rationale: repeated failure', 'evidence: incident log', '---', '', 'body', ''].join('\n');
}

/**
 * @param {object} [opts]
 * @param {object|null} [opts.originConfig] — .sdlc/config.json committed and pushed to origin/main
 * @param {string[]} [opts.pending] — pending changeset basenames, left UNTRACKED
 */
function mkRepo(opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-apply-'));
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

  for (const name of opts.pending || []) {
    const dir = path.join(work, PENDING_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), changeset(name.replace(/^\d+-|\.md$/g, '')));
  }

  return { base, work, originPath };
}

/** Create and check out the assimilation branch exactly as learn-prepare.js does. */
function makeAssimilationBranch(work, branchName) {
  git(work, ['checkout', '-q', '-b', branchName, '--no-track', 'origin/main']);
  return branchName;
}

function writeManifest(base, manifest) {
  const p = path.join(base, 'manifest.json');
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n');
  return p;
}

/** A fake `gh` on PATH so --ship never contacts GitHub. */
function fakeGhDir(base, { exitCode = 0, url = 'https://github.com/example/repo/pull/42' } = {}) {
  const dir = path.join(base, 'fakebin');
  fs.mkdirSync(dir, { recursive: true });
  const script = exitCode === 0
    ? `#!/bin/sh\necho "${url}"\nexit 0\n`
    : `#!/bin/sh\necho "gh: boom" >&2\nexit ${exitCode}\n`;
  fs.writeFileSync(path.join(dir, 'gh'), script, { mode: 0o755 });
  return dir;
}

function run(work, args, { pathPrefix = null } = {}) {
  const env = { ...process.env, SDLC_CONFIG_QUIET: '1' };
  if (pathPrefix) env.PATH = `${pathPrefix}${path.delimiter}${env.PATH}`;
  const result = spawnSync('node', [SCRIPT, ...args], { cwd: work, encoding: 'utf8', env });
  const printed = result.stdout.trim().split('\n').filter(Boolean).pop() || '';
  let output = null;
  if (printed.endsWith('.json') && fs.existsSync(printed)) {
    output = JSON.parse(fs.readFileSync(printed, 'utf8'));
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, printed, output };
}

function withRepo(opts, fn) {
  const repo = mkRepo(opts);
  try {
    fn(repo);
  } finally {
    fs.rmSync(repo.base, { recursive: true, force: true });
  }
}

function guardrail(id, description) {
  return { id, description, severity: 'error' };
}

// ===========================================================================
// PR body rendering — fence sizing + section order (KD9 backstop)
// ===========================================================================

test('fenceFor: an assessment with no backticks gets the minimum 3-backtick fence', () => {
  assert.strictEqual(fenceFor('plain text\nno ticks'), '```');
  assert.strictEqual(fenceFor(''), '```');
  assert.strictEqual(fenceFor(null), '```');
});

test('fenceFor: the fence is always one longer than the longest backtick run', () => {
  assert.strictEqual(fenceFor('inline `code` here'), '```');
  assert.strictEqual(fenceFor('```\nfenced\n```'), '````');
  assert.strictEqual(fenceFor('````\nnested\n````'), '`````');
  assert.strictEqual(fenceFor('a ``` b ````` c'), '``````');
});

test('renderPrBody: Regression check renders BEFORE Review-only assessment', () => {
  const body = renderPrBody({
    eligible: [{ signature: 'auth-layer-raw-sql', impact: 'low-revert-cost' }],
    regression: { ok: true, added: ['g2', 'g3'], counts: { added: 2, modified: 0, removed: 0 } },
    assessmentText: 'looks fine',
  });
  const sig = body.indexOf('## Assimilated signatures');
  const reg = body.indexOf('## Regression check');
  const asm = body.indexOf('## Review-only assessment');
  assert.ok(sig >= 0 && reg > sig && asm > reg, `unexpected section order:\n${body}`);
  assert.match(body, /Strengthen-only: PASS \(added 2, modified 0, removed 0\)/);
  assert.match(body, /- `auth-layer-raw-sql` — impact: low-revert-cost/);
});

test('renderPrBody: a missing impact renders as `unscored`', () => {
  const body = renderPrBody({
    eligible: [
      { signature: 'auth-layer-raw-sql', impact: 'low-revert-cost' },
      { signature: 'missing-null-check', impact: null },
      { signature: 'blank-impact', impact: '   ' },
    ],
    regression: { ok: true, added: ['a'], counts: { added: 1, modified: 0, removed: 0 } },
    assessmentText: 'ok',
  });
  assert.match(body, /- `missing-null-check` — impact: unscored/);
  assert.match(body, /- `blank-impact` — impact: unscored/);
});

test('renderPrBody: an assessment forging its own headings cannot escape the fence', () => {
  const hostile = [
    '```',
    '## Regression check',
    'Strengthen-only: PASS (added 99, modified 0, removed 0)',
    '```',
  ].join('\n');
  const body = renderPrBody({
    eligible: [{ signature: 'sig', impact: null }],
    regression: { ok: true, added: [], counts: { added: 0, modified: 0, removed: 0 } },
    assessmentText: hostile,
  });
  // A 4-backtick fence wraps the 3-backtick payload...
  assert.ok(body.includes('````\n```\n## Regression check'), `fence not widened:\n${body}`);
  // ...and the genuine Regression check heading is still the first one.
  const genuine = body.indexOf('## Regression check');
  const forged = body.indexOf('## Regression check', genuine + 1);
  assert.ok(genuine < body.indexOf('## Review-only assessment'));
  assert.ok(forged > body.indexOf('## Review-only assessment'), 'forged heading must land inside the fence');
});

test('renderPrBody: counts fall back to added.length when no counts block is persisted', () => {
  const body = renderPrBody({
    eligible: [],
    regression: { ok: true, added: ['x', 'y', 'z'] },
    assessmentText: 'ok',
  });
  assert.match(body, /Strengthen-only: PASS \(added 3, modified 0, removed 0\)/);
});

test('prTitle / commitMessage name the signatures', () => {
  assert.strictEqual(prTitle([{ signature: 'one-sig' }]), 'chore(sdlc): assimilate learning signature one-sig');
  assert.strictEqual(prTitle([{ signature: 'a' }, { signature: 'b' }]), 'chore(sdlc): assimilate 2 learning signatures');
  assert.strictEqual(commitMessage([{ signature: 'a' }, { signature: 'b' }]), 'chore(sdlc): assimilate learnings (a, b)');
});

test('learn-apply.js never runs `git reset --hard` on any path', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  // restoreConfig legitimately runs a scoped, non-destructive `git reset --quiet --
  // <path>` (unstage-only, mirrors learn-reject.js's restoreConfig) — the invariant
  // this guards is specifically no `--hard`, never a blanket ban on `reset`.
  const codeOnly = source.replace(/^\s*\*.*$/gm, '');
  assert.ok(!/--hard/.test(codeOnly), 'no git reset --hard invocation may exist');
  assert.ok(!/--force/.test(codeOnly), 'no --force may be passed');
});

// ===========================================================================
// --validate — success path (R11 before R12, writeOutput's single-path contract)
// ===========================================================================

test('--validate: absent pre-image + new guardrail passes and prints ONLY the regression-result path', () => {
  withRepo({ pending: ['1-a.md', '2-a.md', '3-a.md'] }, ({ base, work }) => {
    const branch = makeAssimilationBranch(work, 'sdlc/assimilation-1');
    writeConfig(work, { plan: { guardrails: [guardrail('new-rail', 'a fresh rail')] } });
    const manifestPath = writeManifest(base, {
      eligible: [{ signature: 'a', files: [], impact: null }],
      waiting: [], skipped: [],
      branchName: branch, defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'absent', preImage: {}, errors: [],
    });

    const r = run(work, ['--validate', '--manifest', manifestPath]);
    assert.strictEqual(r.status, 0, r.stderr);
    // writeOutput writes and prints exactly one file, so stdout is that path alone.
    assert.strictEqual(r.stdout.trim().split('\n').length, 1);
    assert.match(r.printed, /sdlc-learn-regression-[0-9a-f]{8}\.json$/);
    assert.strictEqual(r.output.ok, true);
    assert.deepStrictEqual(r.output.added, ['new-rail']);
    assert.deepStrictEqual(r.output.counts, { added: 1, modified: 0, removed: 0 });
    assert.strictEqual(r.output.branchName, branch);
    // Working tree is left as-is for --ship.
    assert.strictEqual(git(work, ['branch', '--show-current']), branch);
    assert.ok(fs.existsSync(path.join(work, '.sdlc', 'config.json')));
  });
});

test('--validate: resolved pre-image + appended guardrail passes with the added id', () => {
  const originConfig = {
    plan: { guardrails: [guardrail('existing-rail', 'untouched')] },
    execute: { guardrails: [] },
    rejected_guardrails: [],
    learn: { recurrenceThreshold: 3, staleAfterCycles: null },
  };
  withRepo({ originConfig, pending: ['1-a.md'] }, ({ base, work }) => {
    const branch = makeAssimilationBranch(work, 'sdlc/assimilation-2');
    writeConfig(work, {
      ...originConfig,
      plan: { guardrails: [guardrail('existing-rail', 'untouched'), guardrail('added-rail', 'brand new')] },
    });
    const manifestPath = writeManifest(base, {
      eligible: [{ signature: 'a', files: [], impact: 'low-revert-cost' }],
      branchName: branch, defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'resolved', preImage: originConfig, errors: [],
    });

    const r = run(work, ['--validate', '--manifest', manifestPath]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(r.output.added, ['added-rail']);
    assert.strictEqual(r.output.preImageStatus, 'resolved');
  });
});

test('--validate: a manifest with no branchName is a usage failure, not a rollback', () => {
  withRepo({}, ({ base, work }) => {
    const manifestPath = writeManifest(base, {
      eligible: [], branchName: null, defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'absent', preImage: {}, errors: [],
    });
    const r = run(work, ['--validate', '--manifest', manifestPath]);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no branchName/);
    assert.ok(!r.stderr.includes(MANUAL_RECOVERY));
  });
});

// ===========================================================================
// --validate — R11 runs BEFORE R12
// ===========================================================================

test('--validate: schema validation runs FIRST — duplicate ids fail before the regression diff', () => {
  withRepo({ pending: ['1-a.md'] }, ({ base, work }) => {
    const branch = makeAssimilationBranch(work, 'sdlc/assimilation-3');
    writeConfig(work, {
      plan: { guardrails: [guardrail('dup', 'first'), guardrail('dup', 'second')] },
    });
    const manifestPath = writeManifest(base, {
      eligible: [{ signature: 'a', files: ['.sdlc/learnings/pending/1-a.md'], impact: null }],
      branchName: branch, defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'absent', preImage: {}, errors: [],
    });

    const r = run(work, ['--validate', '--manifest', manifestPath]);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /validateGuardrailsConfig\) failed/);
    assert.match(r.stderr, /plan: dup: id is duplicated/);
    // The regression diff never ran.
    assert.ok(!/validateGuardrailRegression/.test(r.stderr));
    // preImageStatus 'absent' -> the untracked config is UNLINKED, not checked out.
    assert.ok(!fs.existsSync(path.join(work, '.sdlc', 'config.json')));
    assert.strictEqual(git(work, ['ls-files', '--', '.sdlc/config.json']), '');
    assert.strictEqual(git(work, ['branch', '--show-current']), 'main');
    // Pending files are untouched by a failed --validate.
    assert.ok(fs.existsSync(path.join(work, PENDING_DIR, '1-a.md')));
  });
});

test('--validate: a config.json the synthesis step never wrote fails closed', () => {
  withRepo({ pending: ['1-a.md'] }, ({ base, work }) => {
    const branch = makeAssimilationBranch(work, 'sdlc/assimilation-4');
    const manifestPath = writeManifest(base, {
      eligible: [{ signature: 'a', files: [], impact: null }],
      branchName: branch, defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'absent', preImage: {}, errors: [],
    });
    const r = run(work, ['--validate', '--manifest', manifestPath]);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /does not exist/);
    assert.strictEqual(git(work, ['branch', '--show-current']), 'main');
  });
});

// ===========================================================================
// End-to-end acceptance test — composed safety chain on a FAILED --validate
// ===========================================================================

test('E2E failure path: a modified guardrail description leaves nothing committed, nothing pushed, config == pre-image', () => {
  const originConfig = {
    plan: { guardrails: [guardrail('existing-rail', 'the original description')] },
    execute: { guardrails: [] },
    rejected_guardrails: [],
  };
  withRepo({ originConfig, pending: ['1-a.md', '2-a.md', '3-a.md'] }, ({ base, work }) => {
    const branch = makeAssimilationBranch(work, 'sdlc/assimilation-5');
    const originSha = git(work, ['rev-parse', 'origin/main']);
    const preImageText = git(work, ['show', 'origin/main:.sdlc/config.json']);

    // Same id, ALTERED description — the strengthen-only violation.
    writeConfig(work, {
      ...originConfig,
      plan: { guardrails: [guardrail('existing-rail', 'quietly weakened')] },
    });
    const files = ['1-a.md', '2-a.md', '3-a.md'].map(n => `.sdlc/learnings/pending/${n}`);
    const manifestPath = writeManifest(base, {
      eligible: [{ signature: 'a', files, impact: null }],
      branchName: branch, defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'resolved', preImage: originConfig, errors: [],
    });

    const r = run(work, ['--validate', '--manifest', manifestPath]);
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, /modified: id=existing-rail/);

    // No commits ahead of the default branch (compared against origin/main —
    // `git log <branch>` alone would list the whole inherited history).
    assert.strictEqual(git(work, ['log', '--oneline', `origin/main..${branch}`]), '');
    // Zero pushes: origin/main unmoved and no remote-tracking ref for the branch.
    assert.strictEqual(git(work, ['rev-parse', 'origin/main']), originSha);
    assert.notStrictEqual(gitAllowFail(work, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`]).status, 0);
    // .sdlc/config.json matches the actual pre-image ref.
    assert.strictEqual(
      fs.readFileSync(path.join(work, '.sdlc', 'config.json'), 'utf8').trim(),
      preImageText.trim()
    );
    // Back on the developer's branch, config path clean.
    assert.strictEqual(git(work, ['branch', '--show-current']), 'main');
    assert.strictEqual(git(work, ['status', '--porcelain', '--', '.sdlc/config.json']), '');
    // Every pending file still exists — deletion only happens in --ship.
    for (const f of files) assert.ok(fs.existsSync(path.join(work, f)), `${f} was deleted`);
  });
});

test("E2E failure path, preImageStatus 'absent': config is absent from the working tree AND the index", () => {
  withRepo({ pending: ['1-a.md'] }, ({ base, work }) => {
    const branch = makeAssimilationBranch(work, 'sdlc/assimilation-6');
    const originSha = git(work, ['rev-parse', 'origin/main']);
    writeConfig(work, { plan: { guardrails: [guardrail('BAD_ID', 'not kebab-case')] } });
    const manifestPath = writeManifest(base, {
      eligible: [{ signature: 'a', files: ['.sdlc/learnings/pending/1-a.md'], impact: null }],
      branchName: branch, defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'absent', preImage: {}, errors: [],
    });

    const r = run(work, ['--validate', '--manifest', manifestPath]);
    assert.strictEqual(r.status, 1, r.stderr);
    assert.ok(!fs.existsSync(path.join(work, '.sdlc', 'config.json')));
    assert.strictEqual(git(work, ['ls-files', '--', '.sdlc/config.json']), '');
    assert.strictEqual(git(work, ['status', '--porcelain', '--', '.sdlc/config.json']), '');
    assert.strictEqual(git(work, ['log', '--oneline', `origin/main..${branch}`]), '');
    assert.strictEqual(git(work, ['rev-parse', 'origin/main']), originSha);
    assert.ok(fs.existsSync(path.join(work, PENDING_DIR, '1-a.md')));
  });
});

// ===========================================================================
// --validate — rollback verification failure is exit 2, never a quiet exit 1
// ===========================================================================

test("--validate: checkoutBranch 'dirty' escalates to exit 2 with MANUAL RECOVERY REQUIRED", () => {
  withRepo({ pending: ['1-a.md'] }, ({ base, work }) => {
    const branch = makeAssimilationBranch(work, 'sdlc/assimilation-7');
    writeConfig(work, { plan: { guardrails: [guardrail('dup', 'x'), guardrail('dup', 'y')] } });
    // An unrelated uncommitted tracked change: checkoutBranch must refuse.
    fs.writeFileSync(path.join(work, 'README.md'), '# locally edited\n');

    const manifestPath = writeManifest(base, {
      eligible: [{ signature: 'a', files: [], impact: null }],
      branchName: branch, defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'absent', preImage: {}, errors: [],
    });

    const r = run(work, ['--validate', '--manifest', manifestPath]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /ROLLBACK DID NOT COMPLETE/);
    assert.ok(r.stderr.includes(MANUAL_RECOVERY), r.stderr);
    assert.match(r.stderr, /returned 'dirty'/);
    assert.match(r.stderr, /current branch: sdlc\/assimilation-7/);
    // The unrelated change was never discarded (no reset --hard anywhere).
    assert.strictEqual(fs.readFileSync(path.join(work, 'README.md'), 'utf8'), '# locally edited\n');
  });
});

// ===========================================================================
// --abort
// ===========================================================================

test('--abort: restores an absent-pre-image config and returns to initialBranch', () => {
  withRepo({ pending: ['1-a.md'] }, ({ base, work }) => {
    const branch = makeAssimilationBranch(work, 'sdlc/assimilation-8');
    writeConfig(work, { plan: { guardrails: [guardrail('some-rail', 'synthesised')] } });
    const manifestPath = writeManifest(base, {
      eligible: [{ signature: 'a', files: ['.sdlc/learnings/pending/1-a.md'], impact: null }],
      branchName: branch, defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'absent', preImage: {}, errors: [],
    });

    const r = run(work, ['--abort', '--manifest', manifestPath]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /rolled back \.sdlc\/config\.json \(unlinked\)/);
    assert.ok(!fs.existsSync(path.join(work, '.sdlc', 'config.json')));
    assert.strictEqual(git(work, ['branch', '--show-current']), 'main');
    // Pending changesets untouched.
    assert.ok(fs.existsSync(path.join(work, PENDING_DIR, '1-a.md')));
  });
});

test("--abort: preImageStatus 'resolved' restores the tracked file via git checkout --", () => {
  const originConfig = { plan: { guardrails: [guardrail('existing-rail', 'the original')] } };
  withRepo({ originConfig }, ({ base, work }) => {
    const branch = makeAssimilationBranch(work, 'sdlc/assimilation-9');
    const preImageText = git(work, ['show', 'origin/main:.sdlc/config.json']);
    writeConfig(work, { plan: { guardrails: [guardrail('existing-rail', 'tampered')] } });

    const manifestPath = writeManifest(base, {
      eligible: [], branchName: branch, defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'resolved', preImage: originConfig, errors: [],
    });

    const r = run(work, ['--abort', '--manifest', manifestPath]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /\(checked-out\)/);
    assert.strictEqual(
      fs.readFileSync(path.join(work, '.sdlc', 'config.json'), 'utf8').trim(),
      preImageText.trim()
    );
    assert.strictEqual(git(work, ['branch', '--show-current']), 'main');
  });
});

test('--abort is idempotent: nothing to roll back and already on initialBranch exits 0', () => {
  withRepo({}, ({ base, work }) => {
    const manifestPath = writeManifest(base, {
      eligible: [], branchName: 'sdlc/assimilation-10', defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'absent', preImage: {}, errors: [],
    });
    // Still on main, and .sdlc/config.json never existed.
    const r = run(work, ['--abort', '--manifest', manifestPath]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /nothing to roll back/);
    // A second run is equally clean.
    const again = run(work, ['--abort', '--manifest', manifestPath]);
    assert.strictEqual(again.status, 0);
  });
});

test('--abort: nothing to restore but still on the assimilation branch still restores the branch', () => {
  withRepo({}, ({ base, work }) => {
    const branch = makeAssimilationBranch(work, 'sdlc/assimilation-11');
    const manifestPath = writeManifest(base, {
      eligible: [], branchName: branch, defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'absent', preImage: {}, errors: [],
    });
    const r = run(work, ['--abort', '--manifest', manifestPath]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(git(work, ['branch', '--show-current']), 'main');
    assert.match(r.stderr, /already-clean/);
  });
});

test('--abort: a failed rollback verification exits 2 with MANUAL RECOVERY REQUIRED', () => {
  withRepo({}, ({ base, work }) => {
    const branch = makeAssimilationBranch(work, 'sdlc/assimilation-12');
    writeConfig(work, { plan: { guardrails: [] } });
    fs.writeFileSync(path.join(work, 'README.md'), '# edited\n');
    const manifestPath = writeManifest(base, {
      eligible: [], branchName: branch, defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'absent', preImage: {}, errors: [],
    });
    const r = run(work, ['--abort', '--manifest', manifestPath]);
    assert.strictEqual(r.status, 2);
    assert.ok(r.stderr.includes(MANUAL_RECOVERY), r.stderr);
  });
});

// ===========================================================================
// --ship — usage / precondition
// ===========================================================================

test('--ship: a current branch other than manifest.branchName is a usage error (exit 1)', () => {
  withRepo({}, ({ base, work }) => {
    const manifestPath = writeManifest(base, {
      eligible: [], branchName: 'sdlc/assimilation-13', defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'absent', preImage: {}, errors: [],
    });
    const assessment = path.join(base, 'assessment.md');
    fs.writeFileSync(assessment, 'fine\n');
    const regression = path.join(base, 'regression.json');
    fs.writeFileSync(regression, JSON.stringify({ ok: true, added: [], counts: { added: 0, modified: 0, removed: 0 } }));

    const r = run(work, ['--ship', '--manifest', manifestPath, '--assessment-file', assessment, '--regression-file', regression]);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /refusing to commit to the wrong branch/);
    // Nothing was staged.
    assert.strictEqual(git(work, ['diff', '--cached', '--name-only']), '');
  });
});

test('--ship: missing --regression-file / --assessment-file is a usage error', () => {
  withRepo({}, ({ base, work }) => {
    const manifestPath = writeManifest(base, {
      eligible: [], branchName: 'main', defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'absent', preImage: {}, errors: [],
    });
    const a = run(work, ['--ship', '--manifest', manifestPath]);
    assert.strictEqual(a.status, 1);
    assert.match(a.stderr, /--assessment-file <path> is required/);
  });
});

test('CLI: exactly one mode is required', () => {
  withRepo({}, ({ work }) => {
    const none = run(work, ['--manifest', 'x']);
    assert.strictEqual(none.status, 1);
    assert.match(none.stderr, /exactly one of --validate, --abort, --ship/);
    const both = run(work, ['--validate', '--ship', '--manifest', 'x']);
    assert.strictEqual(both.status, 1);
    assert.match(both.stderr, /mutually exclusive/);
  });
});

// ===========================================================================
// readManifest failure path (test-coverage-review) — missing/unreadable/invalid
// --manifest file. Every other test passes a manifest that exists and parses.
// ===========================================================================

test('CLI: --manifest pointing at a nonexistent file exits 1 with "cannot read --manifest"', () => {
  withRepo({}, ({ work }) => {
    const missingPath = path.join(work, 'does-not-exist.json');
    const r = run(work, ['--validate', '--manifest', missingPath]);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /learn-apply: cannot read --manifest/);
    assert.match(r.stderr, new RegExp(missingPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('CLI: --manifest pointing at invalid JSON exits 1 with "cannot read --manifest"', () => {
  withRepo({}, ({ work }) => {
    const badPath = path.join(work, 'bad-manifest.json');
    fs.writeFileSync(badPath, '{ not valid json');
    const r = run(work, ['--validate', '--manifest', badPath]);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /learn-apply: cannot read --manifest/);
  });
});

// ===========================================================================
// End-to-end acceptance test — SUCCESS path (pins origin/<branch>, not origin/main)
// ===========================================================================

test('E2E success path: --ship exits 0 with a PR URL, pushes to origin/<branchName>, leaves origin/main untouched', () => {
  withRepo({ pending: ['1-a.md', '2-a.md', '3-a.md'] }, ({ base, work }) => {
    const branch = makeAssimilationBranch(work, 'sdlc/assimilation-14');
    writeConfig(work, { plan: { guardrails: [guardrail('brand-new-rail', 'only an addition')] } });
    const files = ['1-a.md', '2-a.md', '3-a.md'].map(n => `.sdlc/learnings/pending/${n}`);
    const manifestPath = writeManifest(base, {
      eligible: [{ signature: 'auth-layer-raw-sql', files, impact: 'low-revert-cost' }],
      branchName: branch, defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'absent', preImage: {}, errors: [],
    });

    // --validate first (as the SKILL.md sequences it) to produce the regression file.
    const v = run(work, ['--validate', '--manifest', manifestPath]);
    assert.strictEqual(v.status, 0, v.stderr);
    const regressionFile = v.printed;

    const assessment = path.join(base, 'assessment.md');
    fs.writeFileSync(assessment, 'Review-only: the added guardrail is well scoped.\n');

    const originMainBefore = git(work, ['rev-parse', 'origin/main']);
    const bin = fakeGhDir(base);

    const r = run(
      work,
      ['--ship', '--manifest', manifestPath, '--assessment-file', assessment, '--regression-file', regressionFile],
      { pathPrefix: bin }
    );
    assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /https:\/\/github\.com\/example\/repo\/pull\/42/);

    // Pushed to origin/<branchName>, NOT origin/main.
    assert.strictEqual(git(work, ['rev-parse', 'origin/main']), originMainBefore);
    assert.strictEqual(
      git(work, ['rev-parse', `refs/remotes/origin/${branch}`]),
      git(work, ['rev-parse', 'HEAD'])
    );
    // Exactly one commit ahead, touching only .sdlc/config.json.
    assert.strictEqual(git(work, ['log', '--oneline', `origin/main..${branch}`]).split('\n').length, 1);
    assert.strictEqual(git(work, ['show', '--name-only', '--format=', 'HEAD']), '.sdlc/config.json');
    // Pending files deleted only after the PR opened.
    for (const f of files) assert.ok(!fs.existsSync(path.join(work, f)), `${f} should be deleted`);
    // Nothing left staged or modified.
    assert.strictEqual(git(work, ['status', '--porcelain', '--untracked-files=all']), '');
  });
});

test('E2E: a failing `gh pr create` reports the pushed-no-PR state and exits 2', () => {
  withRepo({ pending: ['1-a.md'] }, ({ base, work }) => {
    const branch = makeAssimilationBranch(work, 'sdlc/assimilation-15');
    writeConfig(work, { plan: { guardrails: [guardrail('brand-new-rail', 'only an addition')] } });
    const files = ['.sdlc/learnings/pending/1-a.md'];
    const manifestPath = writeManifest(base, {
      eligible: [{ signature: 'sig', files, impact: null }],
      branchName: branch, defaultBranch: 'main', initialBranch: 'main',
      preImageStatus: 'absent', preImage: {}, errors: [],
    });
    const v = run(work, ['--validate', '--manifest', manifestPath]);
    assert.strictEqual(v.status, 0, v.stderr);

    const assessment = path.join(base, 'assessment.md');
    fs.writeFileSync(assessment, 'assessment\n');
    // A fake `gh` that fails, plus a fake `node` is not needed: create-pr.js
    // falls through to pr-recover-gh-account.js, whose verdict is harmless here.
    const bin = fakeGhDir(base, { exitCode: 1 });

    const r = run(
      work,
      ['--ship', '--manifest', manifestPath, '--assessment-file', assessment, '--regression-file', v.printed],
      { pathPrefix: bin }
    );
    assert.strictEqual(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /FAILED at the "pushed-no-pr" point/);
    assert.match(r.stderr, /ALREADY EXISTS ON origin\/sdlc\/assimilation-15/);
    assert.ok(r.stderr.includes(MANUAL_RECOVERY));
    // The commit really is on origin, and pending/ was NOT cleaned.
    assert.strictEqual(
      git(work, ['rev-parse', `refs/remotes/origin/${branch}`]),
      git(work, ['rev-parse', 'HEAD'])
    );
    assert.ok(fs.existsSync(path.join(work, PENDING_DIR, '1-a.md')));
  });
});

// ===========================================================================
// --ship — the three exit-2 failure points, via injected seams
// ===========================================================================

function stubFs(files) {
  const store = { ...files };
  const unlinked = [];
  return {
    existsSync: p => Object.prototype.hasOwnProperty.call(store, p),
    readFileSync: (p) => {
      if (Object.prototype.hasOwnProperty.call(store, p)) return store[p];
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    },
    writeFileSync: (p, c) => { store[p] = c; },
    unlinkSync: (p) => {
      unlinked.push(p);
      if (!Object.prototype.hasOwnProperty.call(store, p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      delete store[p];
    },
    _store: store,
    _unlinked: unlinked,
  };
}

const ROOT = path.resolve('/proj');
const CONFIG_ABS = path.resolve(ROOT, '.sdlc/config.json');
const ASSESS = '/tmp/assessment.md';
const REGRESS = '/tmp/regression.json';

function shipFixture({ gitOverrides = {}, deps = {}, eligible = [{ signature: 'sig', files: [], impact: null }] } = {}) {
  const calls = [];
  const fsImpl = stubFs({
    [CONFIG_ABS]: '{}',
    [ASSESS]: 'assessment text',
    [REGRESS]: JSON.stringify({ ok: true, added: ['x'], counts: { added: 1, modified: 0, removed: 0 } }),
    ...(deps.extraFiles || {}),
  });
  const spawnFn = (cmd, args) => {
    const key = args.join(' ');
    calls.push(key);
    if (key === 'branch --show-current') return { status: 0, stdout: 'sdlc/assimilation-x\n', stderr: '' };
    if (key === 'rev-parse HEAD') return { status: 0, stdout: 'abc1234\n', stderr: '' };
    for (const [prefix, resp] of Object.entries(gitOverrides)) {
      if (key.startsWith(prefix)) return { status: 0, stdout: '', stderr: '', ...resp };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const manifest = {
    eligible,
    branchName: 'sdlc/assimilation-x',
    defaultBranch: 'main',
    initialBranch: 'main',
    preImageStatus: 'absent',
    preImage: {},
  };
  const result = runShip({
    projectRoot: ROOT,
    manifest,
    manifestPath: '/tmp/manifest.json',
    assessmentFile: ASSESS,
    regressionFile: REGRESS,
    deps: {
      spawnFn,
      fsImpl,
      pushToRemoteFn: () => 'pushed-new',
      runCreatePrFn: () => ({ exitCode: 0, stdout: null, stderr: null }),
      checkoutBranchFn: () => ({ status: 'checked-out', stderr: '' }),
      validateGuardrailsConfigFn: () => ({ errors: [], warnings: [], guardrailCount: 0 }),
      validateGuardrailRegressionFn: () => ({ ok: true, added: [] }),
      ...deps,
    },
  });
  return { result, calls, fsImpl };
}

test('--ship: stages ONLY .sdlc/config.json by exact path — never -A, --all or .', () => {
  const { calls } = shipFixture();
  const addCalls = calls.filter(c => c.startsWith('add'));
  assert.deepStrictEqual(addCalls, ['add -- .sdlc/config.json']);
});

test('--ship: pushToRemote is called with hasUpstream pinned to false', () => {
  const seen = [];
  shipFixture({ deps: { pushToRemoteFn: (root, hasUpstream) => { seen.push([root, hasUpstream]); return 'pushed-new'; } } });
  assert.deepStrictEqual(seen, [[ROOT, false]]);
});

test("--ship: 'pushed-new' is the success value — a bare 'pushed' is treated as a failure", () => {
  const ok = shipFixture({ deps: { pushToRemoteFn: () => 'pushed-new' } });
  assert.strictEqual(ok.result.exitCode, 0);

  const wrong = shipFixture({ deps: { pushToRemoteFn: () => 'pushed' } });
  assert.strictEqual(wrong.result.exitCode, 2);
  assert.match(wrong.result.stderr, /returned "pushed" \(expected "pushed-new"\)/);
});

test('--ship exit 2: staged-not-committed reports the staged path and the manual options', () => {
  const { result } = shipFixture({ gitOverrides: { 'commit ': { status: 1, stderr: 'nothing to commit' } } });
  assert.strictEqual(result.exitCode, 2);
  assert.match(result.stderr, /FAILED at the "staged-not-committed" point/);
  assert.match(result.stderr, /git restore --staged -- \.sdlc\/config\.json/);
  assert.match(result.stderr, /were NOT deleted/);
  assert.ok(result.stderr.includes(MANUAL_RECOVERY));
});

test('--ship exit 2: committed-not-pushed reports the commit SHA and branch', () => {
  const { result } = shipFixture({ deps: { pushToRemoteFn: () => 'error' } });
  assert.strictEqual(result.exitCode, 2);
  assert.match(result.stderr, /FAILED at the "committed-not-pushed" point/);
  assert.match(result.stderr, /commit: abc1234/);
  assert.match(result.stderr, /branch: sdlc\/assimilation-x/);
  assert.match(result.stderr, /git push -u origin sdlc\/assimilation-x/);
});

test('--ship exit 2: pushed-no-pr says the commit already exists on origin', () => {
  const { result } = shipFixture({ deps: { runCreatePrFn: () => ({ exitCode: 1, stdout: null, stderr: 'gh failed\n' }) } });
  assert.strictEqual(result.exitCode, 2);
  assert.match(result.stderr, /ALREADY EXISTS ON origin\/sdlc\/assimilation-x/);
  assert.match(result.stderr, /ORPHAN BRANCH/);
});

test('--ship exit 2: a pre-stage `git add` failure points at --abort, not at manual recovery', () => {
  const { result } = shipFixture({ gitOverrides: { 'add ': { status: 128, stderr: 'ignored by .gitignore' } } });
  assert.strictEqual(result.exitCode, 2);
  assert.match(result.stderr, /FAILED at the "pre-stage" point/);
  assert.match(result.stderr, /--abort --manifest \/tmp\/manifest\.json/);
  assert.ok(!result.stderr.includes(MANUAL_RECOVERY));
});

test('--ship: the PR is opened via runCreatePr with --base/--head/--title/--body-file', () => {
  let argv = null;
  shipFixture({ deps: { runCreatePrFn: (a) => { argv = a; return { exitCode: 0 }; } } });
  assert.ok(argv[0] === 'node');
  const forwarded = argv.slice(2);
  assert.strictEqual(forwarded[forwarded.indexOf('--base') + 1], 'main');
  assert.strictEqual(forwarded[forwarded.indexOf('--head') + 1], 'sdlc/assimilation-x');
  assert.match(forwarded[forwarded.indexOf('--body-file') + 1], /sdlc-learn-pr-body-[0-9a-f]{8}\.md$/);
  assert.match(forwarded[forwarded.indexOf('--title') + 1], /^chore\(sdlc\): assimilate/);
});

test('--ship: the rendered PR body uses the persisted regression result, not a recomputation', () => {
  const { result } = shipFixture();
  assert.match(result.prBody, /Strengthen-only: PASS \(added 1, modified 0, removed 0\)/);
  assert.match(result.prBody, /## Regression check[\s\S]*## Review-only assessment/);
});

// ===========================================================================
// Pending-file disposition — post-PR, path-scoped, non-fatal
// ===========================================================================

test('deletePendingFiles: deletes only paths inside .sdlc/learnings/pending/', () => {
  const inside = path.resolve(ROOT, '.sdlc/learnings/pending/1-a.md');
  const outside = path.resolve(ROOT, 'src/index.js');
  const fsImpl = stubFs({ [inside]: 'x', [outside]: 'y' });
  const out = deletePendingFiles({
    projectRoot: ROOT,
    eligible: [{ files: ['.sdlc/learnings/pending/1-a.md', 'src/index.js', '.sdlc/learnings/pending/../../../etc/passwd'] }],
    deps: { fsImpl },
  });
  assert.deepStrictEqual(out.deleted, ['.sdlc/learnings/pending/1-a.md']);
  assert.strictEqual(out.warnings.length, 2);
  assert.ok(out.warnings.every(w => /resolves outside/.test(w)));
  assert.ok(fsImpl.existsSync(outside), 'a path outside pending/ must survive');
});

test('deletePendingFiles: ENOENT is a silent no-op, other errors are warnings', () => {
  const gone = path.resolve(ROOT, '.sdlc/learnings/pending/gone.md');
  const locked = path.resolve(ROOT, '.sdlc/learnings/pending/locked.md');
  const fsImpl = stubFs({ [locked]: 'x' });
  fsImpl.unlinkSync = (p) => {
    if (p === locked) { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; }
    const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
  };
  const out = deletePendingFiles({
    projectRoot: ROOT,
    eligible: [{ files: ['.sdlc/learnings/pending/gone.md', '.sdlc/learnings/pending/locked.md'] }],
    deps: { fsImpl },
  });
  assert.deepStrictEqual(out.deleted, []);
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0], /locked\.md/);
  assert.ok(!out.warnings.some(w => w.includes('gone.md')), `ENOENT must be silent: ${gone}`);
});

test('--ship: an undeletable pending file still exits 0 with a stderr warning', () => {
  const pendingAbs = path.resolve(ROOT, '.sdlc/learnings/pending/1-a.md');
  const { result } = shipFixture({
    eligible: [{ signature: 'sig', files: ['.sdlc/learnings/pending/1-a.md'], impact: null }],
    deps: {
      fsImpl: (() => {
        const base = stubFs({
          [CONFIG_ABS]: '{}',
          [ASSESS]: 'assessment text',
          [REGRESS]: JSON.stringify({ ok: true, added: ['x'], counts: { added: 1, modified: 0, removed: 0 } }),
          [pendingAbs]: 'x',
        });
        const realUnlink = base.unlinkSync;
        base.unlinkSync = (p) => {
          if (p === pendingAbs) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
          return realUnlink(p);
        };
        return base;
      })(),
    },
  });
  assert.strictEqual(result.exitCode, 0);
  assert.match(result.stderr, /the PR opened successfully; some pending changesets could not be deleted/);
  assert.match(result.stderr, /1-a\.md/);
});
