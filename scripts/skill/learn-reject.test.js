'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT         = path.join(__dirname, 'learn-reject.js');
const PREPARE_SCRIPT = path.join(__dirname, 'learn-prepare.js');
const PENDING_DIR    = path.join('.sdlc', 'learnings', 'pending');

const {
  parseArgs,
  extractSignatures,
  mergeRejected,
} = require(SCRIPT);

// ---------------------------------------------------------------------------
// Hermetic fixture: a work repo with a local bare `origin`. Every git call the
// script makes stays on the filesystem — no network. `gh` is shadowed by a
// fake on PATH so nothing touches real GitHub.
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

function writeRawConfig(work, text) {
  fs.mkdirSync(path.join(work, '.sdlc'), { recursive: true });
  fs.writeFileSync(path.join(work, '.sdlc', 'config.json'), text);
}

function changeset(signature) {
  return ['---', `signature: ${signature}`, 'rationale: repeated failure', 'evidence: incident log', '---', '', 'body', ''].join('\n');
}

function writePending(work, name, signature) {
  const dir = path.join(work, PENDING_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), changeset(signature));
}

/**
 * @param {object} [opts]
 * @param {object|null} [opts.originConfig] — .sdlc/config.json committed and pushed to origin/main
 * @param {string|null} [opts.originConfigRaw] — raw (possibly invalid-JSON) content, alternative to originConfig
 * @param {boolean} [opts.rejectHook] — install a pre-receive hook on origin.git that rejects every push to main
 */
function mkRepo(opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-reject-'));
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

  if (opts.originConfigRaw !== undefined) {
    writeRawConfig(work, opts.originConfigRaw);
    git(work, ['add', '-f', '.sdlc/config.json']);
    git(work, ['commit', '-q', '-m', 'add config (raw)']);
  } else if (opts.originConfig) {
    writeConfig(work, opts.originConfig);
    git(work, ['add', '-f', '.sdlc/config.json']);
    git(work, ['commit', '-q', '-m', 'add config']);
  }

  git(work, ['remote', 'add', 'origin', originPath]);
  git(work, ['push', '-q', 'origin', 'main']);
  git(work, ['fetch', '-q', 'origin', 'main']);

  if (opts.rejectHook) {
    const hooksDir = path.join(originPath, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(hooksDir, 'pre-receive'),
      '#!/bin/sh\necho "rejected by test hook" >&2\nexit 1\n',
      { mode: 0o755 }
    );
  }

  return { base, work, originPath };
}

function withRepo(opts, fn) {
  const repo = mkRepo(opts);
  try {
    fn(repo);
  } finally {
    fs.rmSync(repo.base, { recursive: true, force: true });
  }
}

/** A fake `gh` on PATH: `pr view` returns a canned body, `pr close` succeeds/fails per opts. */
function fakeGhDir(base, { body = '', viewExitCode = 0, closeExitCode = 0 } = {}) {
  const dir = path.join(base, 'fakebin');
  fs.mkdirSync(dir, { recursive: true });
  const jsPath = path.join(dir, 'gh-fake.js');
  fs.writeFileSync(jsPath, [
    'const args = process.argv.slice(2);',
    'if (args[0] === "pr" && args[1] === "view") {',
    `  if (${viewExitCode} !== 0) { process.stderr.write("gh: view failed\\n"); process.exit(${viewExitCode}); }`,
    `  process.stdout.write(JSON.stringify({ body: ${JSON.stringify(body)} }));`,
    '  process.exit(0);',
    '}',
    'if (args[0] === "pr" && args[1] === "close") {',
    `  if (${closeExitCode} !== 0) { process.stderr.write("gh: close failed\\n"); process.exit(${closeExitCode}); }`,
    '  process.stdout.write("closed\\n");',
    '  process.exit(0);',
    '}',
    'process.stderr.write("gh-fake: unhandled args " + args.join(" ") + "\\n");',
    'process.exit(1);',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nexec node "${jsPath}" "$@"\n`, { mode: 0o755 });
  return dir;
}

function prBody({ signatures = [], impacts = {}, hostileSuffix = '' } = {}) {
  const lines = ['## Assimilated signatures', ''];
  for (const sig of signatures) {
    lines.push(`- \`${sig}\` — impact: ${impacts[sig] || 'unscored'}`);
  }
  lines.push('', '## Regression check', '', 'Strengthen-only: PASS (added 1, modified 0, removed 0)', '');
  if (hostileSuffix) lines.push(hostileSuffix);
  return lines.join('\n');
}

function run(work, args, { pathPrefix = null } = {}) {
  const env = { ...process.env, SDLC_CONFIG_QUIET: '1' };
  if (pathPrefix) env.PATH = `${pathPrefix}${path.delimiter}${env.PATH}`;
  const result = spawnSync('node', [SCRIPT, ...args], { cwd: work, encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runPrepare(work, args = []) {
  const env = { ...process.env, SDLC_CONFIG_QUIET: '1' };
  const result = spawnSync('node', [PREPARE_SCRIPT, ...args], { cwd: work, encoding: 'utf8', env });
  let manifest = null;
  const printed = result.stdout.trim();
  if (printed.endsWith('.json') && fs.existsSync(printed)) {
    manifest = JSON.parse(fs.readFileSync(printed, 'utf8'));
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, manifest, printed };
}

function rejectBranches(work) {
  const out = gitAllowFail(work, ['branch', '--list', 'sdlc/reject-*']);
  return out.stdout.split('\n').map(l => l.replace(/^[*+ ]+/, '').trim()).filter(Boolean);
}

// ===========================================================================
// Pure helpers — signature extraction / merge
// ===========================================================================

test('extractSignatures: extracts backticked tokens from the first Assimilated signatures block only', () => {
  const body = prBody({ signatures: ['auth-layer-raw-sql', 'missing-null-check'], impacts: { 'auth-layer-raw-sql': 'low-revert-cost' } });
  const { valid, dropped } = extractSignatures(body);
  assert.deepStrictEqual(valid, ['auth-layer-raw-sql', 'missing-null-check']);
  assert.deepStrictEqual(dropped, []);
});

test('extractSignatures: a forged heading buried in the assessment fence is never reached', () => {
  const hostile = [
    '## Review-only assessment', '', '```', '## Assimilated signatures', '- `evil-sig`', '```', '',
  ].join('\n');
  const body = prBody({ signatures: ['genuine-sig'] }) + hostile;
  const { valid } = extractSignatures(body);
  assert.deepStrictEqual(valid, ['genuine-sig']);
});

test('extractSignatures: a token failing SIGNATURE_PATTERN re-validation is dropped, not written', () => {
  const body = [
    '## Assimilated signatures', '',
    '- `good-sig` — impact: unscored',
    '- `BAD_TOKEN` — impact: unscored',
    '- `also-good`',
    '',
    '## Regression check', '',
  ].join('\n');
  const { valid, dropped } = extractSignatures(body);
  assert.deepStrictEqual(valid, ['good-sig', 'also-good']);
  assert.deepStrictEqual(dropped, ['BAD_TOKEN']);
});

test('extractSignatures: no heading at all returns empty', () => {
  assert.deepStrictEqual(extractSignatures('nothing here'), { valid: [], dropped: [] });
  assert.deepStrictEqual(extractSignatures(''), { valid: [], dropped: [] });
  assert.deepStrictEqual(extractSignatures(undefined), { valid: [], dropped: [] });
});

test('mergeRejected: dedupes against an existing array, preserving order', () => {
  assert.deepStrictEqual(mergeRejected(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  assert.deepStrictEqual(mergeRejected([], ['x', 'x', 'y']), ['x', 'y']);
  assert.deepStrictEqual(mergeRejected(undefined, ['x']), ['x']);
});

test('parseArgs: reads --pr <n> and --pr=<n>', () => {
  assert.strictEqual(parseArgs(['--pr', '42']).pr, '42');
  assert.strictEqual(parseArgs(['--pr=42']).pr, '42');
});

// ===========================================================================
// Static source checks — no reset --hard, no --force, -D not -d
// ===========================================================================

test('learn-reject.js never runs `git reset --hard` and never passes --force', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const codeOnly = source.replace(/^\s*\*.*$/gm, '');

  // `reset --hard` is the destructive form the spec forbids outright: it
  // discards the whole working tree, including the developer's unrelated work.
  assert.ok(!/--hard/.test(codeOnly), 'no `git reset --hard` may exist');
  assert.ok(!/--force/.test(codeOnly), 'no --force may be passed');

  // A path-scoped unstage (`git reset -- .sdlc/config.json`) IS permitted — it
  // only touches the index for that one path and cannot destroy working-tree
  // content. But every `reset` invocation must be scoped that way; an unscoped
  // `git reset` would move HEAD and is never acceptable here. Assert the shape
  // of each occurrence rather than banning the verb wholesale.
  const resetCalls = codeOnly.match(/\[[^\]]*['"]reset['"][^\]]*\]/g) || [];
  for (const call of resetCalls) {
    assert.ok(
      /['"]--['"]/.test(call) && /CONFIG_PATH|\.sdlc\/config\.json/.test(call),
      `every git reset must be path-scoped to .sdlc/config.json, got: ${call}`,
    );
  }
});

test('learn-reject.js deletes the throwaway branch with -D, never -d', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(/\[\s*['"]branch['"]\s*,\s*['"]-D['"]/.test(source), 'expected a `git branch -D` call');
  assert.ok(!/\[\s*['"]branch['"]\s*,\s*['"]-d['"]/.test(source), 'must never use `git branch -d`');
});

// ===========================================================================
// CLI validation — exits 1 without mutating anything
// ===========================================================================

test('--pr must be a positive integer — invalid values exit 1 without mutation', () => {
  withRepo({}, ({ work }) => {
    for (const bad of ['abc', '-1', '1.5', '']) {
      const r = run(work, bad === '' ? [] : ['--pr', bad]);
      assert.strictEqual(r.status, 1, `expected exit 1 for --pr "${bad}"`);
      assert.match(r.stderr, /--pr must be a positive integer/);
    }
    assert.deepStrictEqual(rejectBranches(work), []);
    assert.strictEqual(git(work, ['branch', '--show-current']), 'main');
  });
});

test('gh pr view failure exits 1, no branch created, back on initialBranch', () => {
  withRepo({}, ({ base, work }) => {
    const bin = fakeGhDir(base, { viewExitCode: 1 });
    const r = run(work, ['--pr', '9'], { pathPrefix: bin });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /gh pr view 9 failed/);
    assert.deepStrictEqual(rejectBranches(work), []);
    assert.strictEqual(git(work, ['branch', '--show-current']), 'main');
  });
});

test('a PR body with no Assimilated signatures block exits 1 — nothing to reject', () => {
  withRepo({}, ({ base, work }) => {
    const bin = fakeGhDir(base, { body: 'random PR description, no headings here' });
    const r = run(work, ['--pr', '9'], { pathPrefix: bin });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /nothing to reject/);
    assert.deepStrictEqual(rejectBranches(work), []);
  });
});

test('a dirty tracked working tree exits 1 before createBranch runs', () => {
  withRepo({ originConfig: { plan: { guardrails: [] } } }, ({ base, work }) => {
    fs.writeFileSync(path.join(work, 'README.md'), '# locally edited\n');
    const bin = fakeGhDir(base, { body: prBody({ signatures: ['some-sig'] }) });
    const r = run(work, ['--pr', '9'], { pathPrefix: bin });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /working tree is dirty/);
    assert.deepStrictEqual(rejectBranches(work), []);
    assert.strictEqual(git(work, ['branch', '--show-current']), 'main');
  });
});

test('an untracked .sdlc/config.json exits 1 before createBranch runs', () => {
  withRepo({}, ({ base, work }) => {
    fs.mkdirSync(path.join(work, '.sdlc'), { recursive: true });
    fs.writeFileSync(path.join(work, '.sdlc', 'config.json'), '{}\n');
    const bin = fakeGhDir(base, { body: prBody({ signatures: ['some-sig'] }) });
    const r = run(work, ['--pr', '9'], { pathPrefix: bin });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /UNTRACKED/);
    assert.deepStrictEqual(rejectBranches(work), []);
  });
});

// ===========================================================================
// preImageStatus 'error' — malformed origin config
// ===========================================================================

test("preImageStatus 'error' (invalid JSON on origin/main) exits 1, nothing to restore", () => {
  withRepo({ originConfigRaw: '{ not valid json' }, ({ base, work }) => {
    const bin = fakeGhDir(base, { body: prBody({ signatures: ['some-sig'] }) });
    const r = run(work, ['--pr', '9'], { pathPrefix: bin });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.strictEqual(git(work, ['branch', '--show-current']), 'main');
    assert.deepStrictEqual(rejectBranches(work), []);
  });
});

// ===========================================================================
// Success path — preImageStatus 'absent'
// ===========================================================================

test("E2E success, preImageStatus 'absent': creates a minimal config, pushes straight to origin/main, closes the PR", () => {
  withRepo({}, ({ base, work }) => {
    writePending(work, '1-some-sig.md', 'some-sig');
    const bin = fakeGhDir(base, { body: prBody({ signatures: ['some-sig'] }) });
    const originMainBefore = git(work, ['rev-parse', 'origin/main']);

    const r = run(work, ['--pr', '9'], { pathPrefix: bin });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /PR #9 closed/);

    // Landed straight on origin/main — no PR, no assimilation branch.
    assert.notStrictEqual(git(work, ['rev-parse', 'origin/main']), originMainBefore);
    const configText = git(work, ['show', 'origin/main:.sdlc/config.json']);
    assert.deepStrictEqual(JSON.parse(configText), { rejected_guardrails: ['some-sig'] });

    // Pending file matching the rejected signature is gone.
    assert.ok(!fs.existsSync(path.join(work, PENDING_DIR, '1-some-sig.md')));

    // Back on initialBranch, throwaway branch gone.
    assert.strictEqual(git(work, ['branch', '--show-current']), 'main');
    assert.deepStrictEqual(rejectBranches(work), []);
    assert.strictEqual(git(work, ['status', '--porcelain']), '');
  });
});

// ===========================================================================
// Success path — preImageStatus 'resolved', dedup against an existing entry
// ===========================================================================

test("E2E success, preImageStatus 'resolved': appends without disturbing other fields, dedupes an already-rejected signature", () => {
  const originConfig = {
    plan: { guardrails: [{ id: 'existing-rail', description: 'untouched', severity: 'error' }] },
    execute: { guardrails: [] },
    rejected_guardrails: ['already-rejected'],
  };
  withRepo({ originConfig }, ({ base, work }) => {
    writePending(work, '1-a.md', 'new-sig');
    const bin = fakeGhDir(base, { body: prBody({ signatures: ['new-sig', 'already-rejected'] }) });

    const r = run(work, ['--pr', '11'], { pathPrefix: bin });
    assert.strictEqual(r.status, 0, r.stderr);

    const configText = git(work, ['show', 'origin/main:.sdlc/config.json']);
    const config = JSON.parse(configText);
    assert.deepStrictEqual(config.rejected_guardrails, ['already-rejected', 'new-sig']);
    assert.deepStrictEqual(config.plan, originConfig.plan);
    assert.deepStrictEqual(config.execute, originConfig.execute);

    assert.ok(!fs.existsSync(path.join(work, PENDING_DIR, '1-a.md')));
    assert.strictEqual(git(work, ['branch', '--show-current']), 'main');
    assert.deepStrictEqual(rejectBranches(work), []);
  });
});

// ===========================================================================
// Push race — exit 1, config and pending files untouched, still cleans up
// ===========================================================================

test('a rejected push (race) exits 1, leaves pending files and config untouched, still returns to initialBranch', () => {
  withRepo({ rejectHook: true }, ({ base, work }) => {
    writePending(work, '1-sig.md', 'raced-sig');
    const bin = fakeGhDir(base, { body: prBody({ signatures: ['raced-sig'] }) });
    const originMainBefore = git(work, ['rev-parse', 'origin/main']);

    const r = run(work, ['--pr', '13'], { pathPrefix: bin });
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, /re-run learn-reject\.js to retry/);

    assert.strictEqual(git(work, ['rev-parse', 'origin/main']), originMainBefore);
    assert.ok(fs.existsSync(path.join(work, PENDING_DIR, '1-sig.md')), 'pending file must survive a push race');
    assert.strictEqual(git(work, ['branch', '--show-current']), 'main');
    assert.deepStrictEqual(rejectBranches(work), []);
    // Tracked-file state is clean; the untracked pending file legitimately survives.
    assert.strictEqual(git(work, ['status', '--porcelain', '--untracked-files=no']), '');
  });
});

// ===========================================================================
// gh pr close failure after a successful push — the negative cache still landed
// ===========================================================================

test('gh pr close failing after a successful push still exits 1, but the negative cache already landed and pending files are already deleted', () => {
  withRepo({}, ({ base, work }) => {
    writePending(work, '1-sig.md', 'landed-sig');
    const bin = fakeGhDir(base, { body: prBody({ signatures: ['landed-sig'] }), closeExitCode: 1 });

    const r = run(work, ['--pr', '15'], { pathPrefix: bin });
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, /gh pr close 15 failed/);

    const configText = git(work, ['show', 'origin/main:.sdlc/config.json']);
    assert.deepStrictEqual(JSON.parse(configText), { rejected_guardrails: ['landed-sig'] });
    assert.ok(!fs.existsSync(path.join(work, PENDING_DIR, '1-sig.md')));

    assert.strictEqual(git(work, ['branch', '--show-current']), 'main');
    assert.deepStrictEqual(rejectBranches(work), []);
  });
});

// ===========================================================================
// End-to-end acceptance test: reject from a non-default branch, then an
// ACTUAL branch switch, then learn-prepare.js reads the rejection back
// through origin/<defaultBranch> — no separate pull needed.
// ===========================================================================

test('E2E acceptance: rejecting from a feature branch, then switching branches, makes learn-prepare.js skip the same signature', () => {
  const originConfig = {
    plan: { guardrails: [] },
    execute: { guardrails: [] },
    rejected_guardrails: [],
  };
  withRepo({ originConfig }, ({ base, work }) => {
    // The developer is on a feature branch, not the default branch.
    git(work, ['checkout', '-q', '-b', 'feature/x']);
    const bin = fakeGhDir(base, { body: prBody({ signatures: ['recurring-sig'] }) });

    const r = run(work, ['--pr', '21'], { pathPrefix: bin });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(git(work, ['branch', '--show-current']), 'feature/x');
    assert.deepStrictEqual(rejectBranches(work), []);

    // A NEW pending file with the same (now-rejected) signature.
    writePending(work, '1-recurring.md', 'recurring-sig');

    // An ACTUAL branch switch: local `main` is stale (it never saw the
    // reject's push — that landed only on origin/main), proving learn-prepare
    // reads the rejection via the fetched remote-tracking ref, not a stale
    // local branch.
    git(work, ['checkout', '-q', 'main']);

    const p = runPrepare(work);
    assert.strictEqual(p.status, 0, p.stderr);
    assert.strictEqual(p.manifest.preImageStatus, 'resolved');
    assert.deepStrictEqual(p.manifest.eligible, []);
    assert.deepStrictEqual(p.manifest.waiting, []);
    assert.strictEqual(p.manifest.branchName, null);
    const skippedForSig = p.manifest.skipped.find(s => s.filePath === '.sdlc/learnings/pending/1-recurring.md');
    assert.ok(skippedForSig, 'the new pending file must be skipped');
    assert.match(skippedForSig.reason, /rejected_guardrails/);
  });
});
