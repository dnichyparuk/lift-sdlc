'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parseArgs,
  countDiffLines,
  runRetag,
  runRelease,
  runChangelogCommit,
} = require('./version-execute');

const SCRIPT = path.join(__dirname, 'version-execute.js');

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Build an injectable `spawnFn` keyed on the joined git argument list.
 * Any command without an override succeeds with empty output.
 */
function makeSpawn(overrides = {}) {
  const calls = [];
  const spawnFn = (cmd, args) => {
    assert.strictEqual(cmd, 'git');
    const key = args.join(' ');
    calls.push(key);
    const override = overrides[key];
    if (!override) return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '', ...override };
  };
  return { spawnFn, calls };
}

const OK_SHAS = {
  'rev-parse v1.2.3^{commit}': { stdout: 'old1111' },
  'rev-parse refs/tags/v1.2.3^{commit}': { stdout: 'head222' },
  'rev-parse HEAD': { stdout: 'head222' },
};

const ONE_LINE_DIFF = [
  '--- a/package.json',
  '+++ b/package.json',
  '-  "version": "1.0.0",',
  '+  "version": "1.1.0",',
].join('\n');

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs reads the retag subcommand and --tag', () => {
  const parsed = parseArgs(['node', 'version-execute.js', 'retag', '--tag', 'v1.2.3']);
  assert.strictEqual(parsed.subcommand, 'retag');
  assert.strictEqual(parsed.tag, 'v1.2.3');
  assert.strictEqual(parsed.hotfix, false);
  assert.strictEqual(parsed.expectedHead, null);
});

test('parseArgs reads --expected-head for retag', () => {
  const parsed = parseArgs(['node', 'version-execute.js', 'retag', '--tag', 'v1.2.3', '--expected-head', 'head222']);
  assert.strictEqual(parsed.expectedHead, 'head222');
});

test('parseArgs reads every release flag', () => {
  const parsed = parseArgs([
    'node', 'version-execute.js', 'release',
    '--tag', 'v2.0.0',
    '--hotfix',
    '--version-file', 'package.json',
    '--changelog-file', 'CHANGELOG.md',
    '--no-push',
    '--set-upstream', 'feat/x',
  ]);
  assert.deepStrictEqual(parsed, {
    subcommand: 'release',
    tag: 'v2.0.0',
    hotfix: true,
    versionFile: 'package.json',
    changelogFile: 'CHANGELOG.md',
    noPush: true,
    upstreamBranch: 'feat/x',
    expectedHead: null,
  });
});

test('parseArgs leaves everything unset for a bare changelog-commit', () => {
  const parsed = parseArgs(['node', 'version-execute.js', 'changelog-commit']);
  assert.strictEqual(parsed.subcommand, 'changelog-commit');
  assert.strictEqual(parsed.tag, null);
  assert.strictEqual(parsed.changelogFile, null);
  assert.strictEqual(parsed.noPush, false);
});

test('parseArgs returns a null subcommand for empty argv', () => {
  assert.strictEqual(parseArgs(['node', 'version-execute.js']).subcommand, null);
});

// ---------------------------------------------------------------------------
// countDiffLines
// ---------------------------------------------------------------------------

test('countDiffLines ignores the --- / +++ file headers', () => {
  assert.deepStrictEqual(countDiffLines(ONE_LINE_DIFF), { added: 1, removed: 1 });
});

test('countDiffLines returns zeroes for an empty diff', () => {
  assert.deepStrictEqual(countDiffLines(''), { added: 0, removed: 0 });
});

// ---------------------------------------------------------------------------
// runRetag
// ---------------------------------------------------------------------------

test('runRetag runs the five-command sequence in order and reports ok', () => {
  const { spawnFn, calls } = makeSpawn(OK_SHAS);

  const result = runRetag('v1.2.3', { spawnFn, cwd: '/repo' });

  assert.deepStrictEqual(result, { status: 'ok', tag: 'v1.2.3' });
  assert.deepStrictEqual(calls, [
    'rev-parse v1.2.3^{commit}',
    'tag -d v1.2.3',
    'push origin :refs/tags/v1.2.3',
    'tag -a v1.2.3 -m Retag v1.2.3',
    'push origin v1.2.3',
    'rev-parse refs/tags/v1.2.3^{commit}',
    'rev-parse HEAD',
  ]);
});

test('runRetag warns but still reports ok when the new tag does not resolve to HEAD', () => {
  const { spawnFn } = makeSpawn({
    ...OK_SHAS,
    'rev-parse refs/tags/v1.2.3^{commit}': { stdout: 'somewhereelse' },
  });

  const result = runRetag('v1.2.3', { spawnFn, cwd: '/repo' });

  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.verified, false);
  assert.match(result.warning, /somewhereelse.*head222/);
});

test('runRetag fails without recovery when the local tag delete fails', () => {
  const { spawnFn, calls } = makeSpawn({
    ...OK_SHAS,
    'tag -d v1.2.3': { status: 1, stderr: "error: tag 'v1.2.3' not found." },
  });

  const result = runRetag('v1.2.3', { spawnFn, cwd: '/repo' });

  assert.deepStrictEqual(result, {
    status: 'failed',
    recovered: false,
    failedStep: 'tag-delete',
    reason: "error: tag 'v1.2.3' not found.",
  });
  // Nothing was touched on the remote.
  assert.ok(!calls.some((c) => c.startsWith('push')));
});

test('runRetag recreates the local tag when the remote delete push fails', () => {
  const { spawnFn, calls } = makeSpawn({
    ...OK_SHAS,
    'push origin :refs/tags/v1.2.3': { status: 1, stderr: 'remote: permission denied' },
  });

  const result = runRetag('v1.2.3', { spawnFn, cwd: '/repo' });

  assert.deepStrictEqual(result, {
    status: 'failed',
    recovered: true,
    failedStep: 'push-delete',
    reason: 'remote: permission denied',
  });
  assert.ok(calls.includes('tag -a v1.2.3 -m Retag v1.2.3 old1111'));
});

test('runRetag never leaves both the local and the remote tag gone when tag creation fails', () => {
  const { spawnFn, calls } = makeSpawn({
    ...OK_SHAS,
    'tag -a v1.2.3 -m Retag v1.2.3': { status: 1, stderr: 'fatal: cannot create tag' },
  });

  const result = runRetag('v1.2.3', { spawnFn, cwd: '/repo' });

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.failedStep, 'tag-create');
  assert.strictEqual(result.recovered, true);
  // Recreated at the ORIGINAL sha, so `git push origin v1.2.3` restores the remote.
  assert.strictEqual(calls[calls.length - 1], 'tag -a v1.2.3 -m Retag v1.2.3 old1111');
});

test('runRetag recreates the local tag at its original sha when the re-push fails', () => {
  const { spawnFn, calls } = makeSpawn({
    ...OK_SHAS,
    'push origin v1.2.3': { status: 1, stderr: 'push rejected: non-fast-forward' },
  });

  const result = runRetag('v1.2.3', { spawnFn, cwd: '/repo' });

  assert.deepStrictEqual(result, {
    status: 'failed',
    recovered: true,
    failedStep: 'push',
    reason: 'push rejected: non-fast-forward',
  });
  // The HEAD tag is removed and the original one restored — in that order.
  assert.deepStrictEqual(calls.slice(-2), ['tag -d v1.2.3', 'tag -a v1.2.3 -m Retag v1.2.3 old1111']);
});

test('runRetag reports recovered false when the tag recreation itself fails', () => {
  const { spawnFn } = makeSpawn({
    ...OK_SHAS,
    'push origin v1.2.3': { status: 1, stderr: 'push rejected: non-fast-forward' },
    'tag -a v1.2.3 -m Retag v1.2.3 old1111': { status: 1, stderr: 'fatal: bad object' },
  });

  const result = runRetag('v1.2.3', { spawnFn, cwd: '/repo' });

  assert.strictEqual(result.recovered, false);
});

test('runRetag reports recovered false when the original sha could not be captured', () => {
  const { spawnFn, calls } = makeSpawn({
    ...OK_SHAS,
    'rev-parse v1.2.3^{commit}': { status: 1, stderr: 'fatal: unknown revision' },
    'push origin :refs/tags/v1.2.3': { status: 1, stderr: 'remote: permission denied' },
  });

  const result = runRetag('v1.2.3', { spawnFn, cwd: '/repo' });

  assert.strictEqual(result.recovered, false);
  assert.ok(!calls.some((c) => c.startsWith('tag -a v1.2.3 -m Retag v1.2.3 ')));
});

test('runRetag honours a custom remote and tag message', () => {
  const { spawnFn, calls } = makeSpawn({
    'rev-parse v1.2.3^{commit}': { stdout: 'old1111' },
    'rev-parse refs/tags/v1.2.3^{commit}': { stdout: 'head222' },
    'rev-parse HEAD': { stdout: 'head222' },
  });

  runRetag('v1.2.3', { spawnFn, cwd: '/repo', remote: 'upstream', message: 'Move v1.2.3' });

  assert.ok(calls.includes('push upstream :refs/tags/v1.2.3'));
  assert.ok(calls.includes('tag -a v1.2.3 -m Move v1.2.3'));
  assert.ok(calls.includes('push upstream v1.2.3'));
});

test('runRetag reports ok without a HEAD re-derivation when the tag matches expectedHead', () => {
  const { spawnFn, calls } = makeSpawn(OK_SHAS);

  const result = runRetag('v1.2.3', { spawnFn, cwd: '/repo', expectedHead: 'head222' });

  assert.deepStrictEqual(result, { status: 'ok', tag: 'v1.2.3' });
  // Verification used the approved head, not a fresh `rev-parse HEAD`.
  assert.ok(!calls.includes('rev-parse HEAD'));
});

test('runRetag fails verification when the tag lands on a different commit than the approved head', () => {
  const { spawnFn } = makeSpawn(OK_SHAS);

  const result = runRetag('v1.2.3', { spawnFn, cwd: '/repo', expectedHead: 'approvedhead999' });

  assert.deepStrictEqual(result, {
    status: 'failed',
    failedStep: 'verify',
    reason: 'tag points at head222, approved head was approvedhead999',
  });
  // Both SHAs must be present in the reason for the operator to diagnose the drift.
  assert.match(result.reason, /head222/);
  assert.match(result.reason, /approvedhead999/);
});

// ---------------------------------------------------------------------------
// runRelease
// ---------------------------------------------------------------------------

function releaseOpts(extra = {}) {
  return {
    versionFile: 'package.json',
    changelogFile: 'CHANGELOG.md',
    cwd: '/repo',
    ...extra,
  };
}

test('runRelease runs gate, add, commit, tag and the two-command push', () => {
  const { spawnFn, calls } = makeSpawn({ 'diff -- package.json': { stdout: ONE_LINE_DIFF } });

  const result = runRelease('v1.1.0', releaseOpts({ spawnFn }));

  assert.deepStrictEqual(result, { status: 'ok', tag: 'v1.1.0' });
  assert.deepStrictEqual(calls, [
    'diff -- package.json',
    'add package.json CHANGELOG.md',
    'commit -m chore(release): v1.1.0',
    'tag -a v1.1.0 -m Release v1.1.0',
    'push',
    'push origin v1.1.0',
  ]);
});

test('runRelease annotates hotfix releases with a Type: hotfix trailer', () => {
  const { spawnFn, calls } = makeSpawn({ 'diff -- package.json': { stdout: ONE_LINE_DIFF } });

  runRelease('v1.1.1', releaseOpts({ spawnFn, hotfix: true }));

  assert.ok(calls.includes('commit -m chore(release): v1.1.1 [hotfix]'));
  assert.ok(calls.includes('tag -a v1.1.1 -m Release v1.1.1\n\nType: hotfix'));
});

test('runRelease restores the version file and aborts when more than one line differs', () => {
  const multiLineDiff = [
    '--- a/package.json',
    '+++ b/package.json',
    '-  "version": "1.0.0",',
    '-  "description": "old",',
    '+  "version": "1.1.0",',
    '+  "description": "mangled",',
  ].join('\n');
  const { spawnFn, calls } = makeSpawn({ 'diff -- package.json': { stdout: multiLineDiff } });

  const result = runRelease('v1.1.0', releaseOpts({ spawnFn }));

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.failedStep, 'diff-gate');
  assert.strictEqual(result.restoredVersionFile, true);
  assert.strictEqual(result.diff, multiLineDiff);
  assert.ok(calls.includes('checkout -- package.json'));
  assert.ok(!calls.some((c) => c.startsWith('commit')));
  assert.ok(!calls.some((c) => c.startsWith('tag')));
});

test('runRelease aborts without a checkout when the version file has no changes', () => {
  const { spawnFn, calls } = makeSpawn();

  const result = runRelease('v1.1.0', releaseOpts({ spawnFn }));

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.failedStep, 'diff-gate');
  assert.strictEqual(result.restoredVersionFile, false);
  assert.match(result.reason, /no changes detected/);
  assert.ok(!calls.includes('checkout -- package.json'));
});

test('runRelease skips the gate entirely in tag mode (no version file)', () => {
  const { spawnFn, calls } = makeSpawn();

  const result = runRelease('v1.1.0', { spawnFn, cwd: '/repo', changelogFile: 'CHANGELOG.md' });

  assert.deepStrictEqual(result, { status: 'ok', tag: 'v1.1.0' });
  assert.ok(!calls.some((c) => c.startsWith('diff')));
  assert.strictEqual(calls[0], 'add CHANGELOG.md');
});

test('runRelease refuses to commit when there is nothing to stage', () => {
  const { spawnFn, calls } = makeSpawn();

  const result = runRelease('v1.1.0', { spawnFn, cwd: '/repo' });

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.failedStep, 'add');
  assert.match(result.reason, /no files to stage/);
  assert.deepStrictEqual(calls, []);
});

test('runRelease surfaces a commit failure and never creates the tag', () => {
  const { spawnFn, calls } = makeSpawn({
    'diff -- package.json': { stdout: ONE_LINE_DIFF },
    'commit -m chore(release): v1.1.0': { status: 1, stderr: 'pre-commit hook failed' },
  });

  const result = runRelease('v1.1.0', releaseOpts({ spawnFn }));

  assert.deepStrictEqual(result, {
    status: 'failed',
    failedStep: 'commit',
    reason: 'pre-commit hook failed',
  });
  assert.ok(!calls.some((c) => c.startsWith('tag ')));
});

test('runRelease surfaces a tag failure without pushing', () => {
  const { spawnFn, calls } = makeSpawn({
    'diff -- package.json': { stdout: ONE_LINE_DIFF },
    'tag -a v1.1.0 -m Release v1.1.0': { status: 1, stderr: 'fatal: tag already exists' },
  });

  const result = runRelease('v1.1.0', releaseOpts({ spawnFn }));

  assert.strictEqual(result.failedStep, 'tag');
  assert.ok(!calls.some((c) => c.startsWith('push')));
});

test('runRelease rolls the tag back when the commit push fails after tagging', () => {
  const { spawnFn, calls } = makeSpawn({
    'diff -- package.json': { stdout: ONE_LINE_DIFF },
    push: { status: 1, stderr: 'push rejected: non-fast-forward' },
  });

  const result = runRelease('v1.1.0', releaseOpts({ spawnFn }));

  assert.deepStrictEqual(result, {
    status: 'failed',
    rolledBackTag: true,
    failedStep: 'push',
    reason: 'push rejected: non-fast-forward — local tag v1.1.0 deleted to keep repo state consistent',
  });
  assert.strictEqual(calls[calls.length - 1], 'tag -d v1.1.0');
  // The retag-only `recovered` field must never appear on a release result.
  assert.strictEqual(result.recovered, undefined);
});

test('runRelease keeps the local tag when the tag push fails and returns a recovery command', () => {
  const { spawnFn, calls } = makeSpawn({
    'diff -- package.json': { stdout: ONE_LINE_DIFF },
    'push origin v1.1.0': { status: 1, stderr: 'remote: tag protection rule' },
  });

  const result = runRelease('v1.1.0', releaseOpts({ spawnFn }));

  assert.deepStrictEqual(result, {
    status: 'failed',
    rolledBackTag: false,
    failedStep: 'push-tags',
    reason:
      'remote: tag protection rule — release commit is already on origin; local tag v1.1.0 kept',
    recovery: 'git push origin v1.1.0',
  });
  // The release commit already landed — the local tag must never be deleted.
  assert.ok(!calls.some((c) => c.startsWith('tag -d')));
});

test('runRelease reports rolledBackTag false when the rollback delete fails', () => {
  const { spawnFn } = makeSpawn({
    'diff -- package.json': { stdout: ONE_LINE_DIFF },
    push: { status: 1, stderr: 'push rejected' },
    'tag -d v1.1.0': { status: 1, stderr: 'fatal: cannot delete tag' },
  });

  const result = runRelease('v1.1.0', releaseOpts({ spawnFn }));

  assert.strictEqual(result.rolledBackTag, false);
});

test('runRelease skips both pushes under --no-push', () => {
  const { spawnFn, calls } = makeSpawn({ 'diff -- package.json': { stdout: ONE_LINE_DIFF } });

  const result = runRelease('v1.1.0', releaseOpts({ spawnFn, noPush: true }));

  assert.deepStrictEqual(result, { status: 'ok', tag: 'v1.1.0', pushed: false });
  assert.ok(!calls.some((c) => c.startsWith('push')));
});

test('runRelease sets the upstream on the first push when a branch is given', () => {
  const { spawnFn, calls } = makeSpawn({ 'diff -- package.json': { stdout: ONE_LINE_DIFF } });

  runRelease('v1.1.0', releaseOpts({ spawnFn, upstreamBranch: 'feat/release' }));

  assert.ok(calls.includes('push --set-upstream origin feat/release'));
  assert.ok(calls.includes('push origin v1.1.0'));
});

// ---------------------------------------------------------------------------
// runChangelogCommit
// ---------------------------------------------------------------------------

test('runChangelogCommit runs the add/commit/push shape and creates no tag', () => {
  const { spawnFn, calls } = makeSpawn();

  const result = runChangelogCommit({ spawnFn, cwd: '/repo', tag: 'v1.2.3' });

  assert.deepStrictEqual(result, { status: 'ok' });
  assert.deepStrictEqual(calls, [
    'add CHANGELOG.md',
    'commit -m docs: update changelog for v1.2.3',
    'push',
  ]);
});

test('runChangelogCommit drops the tag from the message when none is given', () => {
  const { spawnFn, calls } = makeSpawn();

  runChangelogCommit({ spawnFn, cwd: '/repo', changelogFile: 'docs/CHANGES.md' });

  assert.deepStrictEqual(calls, [
    'add docs/CHANGES.md',
    'commit -m docs: update changelog',
    'push',
  ]);
});

test('runChangelogCommit skips the push under --no-push', () => {
  const { spawnFn, calls } = makeSpawn();

  const result = runChangelogCommit({ spawnFn, cwd: '/repo', noPush: true });

  assert.deepStrictEqual(result, { status: 'ok', pushed: false });
  assert.ok(!calls.includes('push'));
});

test('runChangelogCommit reports the commit as landed when only the push fails', () => {
  const { spawnFn } = makeSpawn({ push: { status: 1, stderr: 'remote unreachable' } });

  const result = runChangelogCommit({ spawnFn, cwd: '/repo', tag: 'v1.2.3' });

  assert.deepStrictEqual(result, {
    status: 'failed',
    failedStep: 'push',
    reason: 'remote unreachable',
    committed: true,
    pushed: false,
  });
});

test('runChangelogCommit surfaces an add failure', () => {
  const { spawnFn, calls } = makeSpawn({
    'add CHANGELOG.md': { status: 1, stderr: "fatal: pathspec 'CHANGELOG.md' did not match" },
  });

  const result = runChangelogCommit({ spawnFn, cwd: '/repo' });

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.failedStep, 'add');
  assert.ok(!calls.some((c) => c.startsWith('commit')));
});

test('runChangelogCommit surfaces a commit failure', () => {
  const { spawnFn } = makeSpawn({
    'commit -m docs: update changelog': { status: 1, stdout: 'nothing to commit, working tree clean' },
  });

  const result = runChangelogCommit({ spawnFn, cwd: '/repo' });

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.failedStep, 'commit');
  assert.match(result.reason, /nothing to commit/);
});

// ---------------------------------------------------------------------------
// End-to-end CLI
// ---------------------------------------------------------------------------

test('CLI exits 2 with usage text on an unknown subcommand', () => {
  const result = spawnSync(process.execPath, [SCRIPT, 'bogus'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /unknown subcommand "bogus"/);
  assert.match(result.stderr, /Usage:/);
});

test('CLI exits 1 with a JSON failure when retag is missing --tag', () => {
  const result = spawnSync(process.execPath, [SCRIPT, 'retag'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  const parsed = JSON.parse(result.stdout.trim());
  assert.strictEqual(parsed.status, 'failed');
  assert.match(parsed.reason, /--tag <name>/);
});

test('CLI exits 1 with a JSON failure when release is missing --tag', () => {
  const result = spawnSync(process.execPath, [SCRIPT, 'release'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  const parsed = JSON.parse(result.stdout.trim());
  assert.strictEqual(parsed.status, 'failed');
  assert.match(parsed.reason, /--tag <name>/);
});
