'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  parseArgs,
  detectWipSquash,
  runSquash,
  runStashTransaction,
  classifyCommitFailure,
  detectPreCommitHook,
} = require('./commit.js');

const SCRIPT = path.join(__dirname, 'commit.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * A repo on a feature branch with `main` as the fork base and N
 * `wip(execute):` commits stacked on top. No remote is configured, so
 * detectWipSquash() exercises its default-branch fallback path.
 */
function makeRepoWithWip(wipCount = 2) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-squash-')));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'chore: init']);
  const forkPoint = git(dir, ['rev-parse', 'HEAD']).trim();

  git(dir, ['checkout', '-q', '-b', 'feature/x']);
  for (let i = 1; i <= wipCount; i++) {
    fs.writeFileSync(path.join(dir, `wip${i}.txt`), `wip ${i}\n`);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', `wip(execute): wave ${i}`]);
  }
  return { dir, forkPoint };
}

function inDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

function runCli(cwd, args) {
  const result = spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------------------
// parseArgs — execution-mode flags
// ---------------------------------------------------------------------------

test('parseArgs: execution-mode flags default to off', () => {
  const parsed = parseArgs(['node', 'commit.js']);
  assert.strictEqual(parsed.squashExecute, false);
  assert.strictEqual(parsed.stashTransaction, false);
  assert.strictEqual(parsed.forkPoint, null);
  assert.strictEqual(parsed.message, null);
});

test('parseArgs: --squash-execute and --fork-point <sha>', () => {
  const parsed = parseArgs(['node', 'commit.js', '--squash-execute', '--fork-point', 'abc1234']);
  assert.strictEqual(parsed.squashExecute, true);
  assert.strictEqual(parsed.forkPoint, 'abc1234');
});

test('parseArgs: --stash-transaction --message <msg> --amend', () => {
  const parsed = parseArgs(['node', 'commit.js', '--stash-transaction', '--message', 'feat: x', '--amend']);
  assert.strictEqual(parsed.stashTransaction, true);
  assert.strictEqual(parsed.message, 'feat: x');
  assert.strictEqual(parsed.amend, true);
});

test('parseArgs: existing flags still parse alongside the new ones', () => {
  const parsed = parseArgs(['node', 'commit.js', '--no-stash', '--scope', 'api', '--type', 'fix', '--no-squash-wip']);
  assert.strictEqual(parsed.noStash, true);
  assert.strictEqual(parsed.scope, 'api');
  assert.strictEqual(parsed.type, 'fix');
  assert.strictEqual(parsed.noSquashWip, true);
});

// ---------------------------------------------------------------------------
// detectWipSquash — forkPoint is surfaced
// ---------------------------------------------------------------------------

test('detectWipSquash surfaces the resolved forkPoint alongside commits', () => {
  const { dir, forkPoint } = makeRepoWithWip(2);
  try {
    const result = inDir(dir, () => detectWipSquash());
    assert.strictEqual(result.forkPoint, forkPoint);
    assert.strictEqual(result.commits.length, 2);
    assert.strictEqual(result.stagedClean, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectWipSquash forkPoint is the merge-base, not the current branch name', () => {
  const { dir, forkPoint } = makeRepoWithWip(1);
  try {
    const result = inDir(dir, () => detectWipSquash());
    // The old raw-prose fallback resolved to the current branch's own name,
    // which made `git merge-base HEAD <that-branch>` a no-op (it returned HEAD).
    const head = git(dir, ['rev-parse', 'HEAD']).trim();
    assert.notStrictEqual(result.forkPoint, head);
    assert.notStrictEqual(result.forkPoint, 'feature/x');
    assert.strictEqual(result.forkPoint, forkPoint);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectWipSquash reports forkPoint: null when no fork-point resolves', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-nofork-')));
  try {
    git(dir, ['init', '-q', '-b', 'orphan']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'chore: init']);
    const result = inDir(dir, () => detectWipSquash());
    assert.strictEqual(result.forkPoint, null);
    assert.deepStrictEqual(result.commits, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runSquash — uses the detected forkPoint verbatim
// ---------------------------------------------------------------------------

test('runSquash resets to exactly the fork-point it was given, then re-stages', () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = runSquash('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', { spawnFn, cwd: '/tmp' });
  assert.deepStrictEqual(result, { status: 'squashed', forkPoint: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  assert.deepStrictEqual(calls[0], ['reset', '--soft', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']);
  assert.deepStrictEqual(calls[1], ['add', '-A']);
  assert.strictEqual(calls.length, 2);
  // No merge-base is ever re-derived inside the execution path.
  assert.ok(!calls.some(a => a.includes('merge-base')));
  assert.ok(!calls.some(a => a.includes('symbolic-ref')));
});

test('runSquash refuses a missing fork-point instead of guessing', () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  };
  for (const bad of [null, '', '   ']) {
    const result = runSquash(bad, { spawnFn });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /No fork-point resolved/);
  }
  assert.strictEqual(calls.length, 0, 'no git command may run without a fork-point');
});

test('runSquash returns failed when git reset --soft fails and does not run git add', () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push(args);
    return { status: 128, stdout: '', stderr: "fatal: ambiguous argument 'abc123'" };
  };
  const result = runSquash('abc123', { spawnFn });
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.forkPoint, 'abc123');
  assert.match(result.message, /ambiguous argument/);
  assert.strictEqual(calls.length, 1);
});

test('runSquash returns failed when git add -A fails', () => {
  const spawnFn = (cmd, args) => (args[0] === 'reset'
    ? { status: 0, stdout: '', stderr: '' }
    : { status: 1, stdout: '', stderr: 'fatal: could not add' });
  const result = runSquash('abc123', { spawnFn });
  assert.strictEqual(result.status, 'failed');
  assert.match(result.message, /could not add/);
});

test('detectWipSquash forkPoint feeds runSquash: WIP commits vanish, changes stay staged', () => {
  const { dir, forkPoint } = makeRepoWithWip(3);
  try {
    const detected = inDir(dir, () => detectWipSquash());
    assert.strictEqual(detected.commits.length, 3);

    const result = runSquash(detected.forkPoint, { cwd: dir });
    assert.deepStrictEqual(result, { status: 'squashed', forkPoint });

    // History is back at the fork-point.
    assert.strictEqual(git(dir, ['rev-parse', 'HEAD']).trim(), forkPoint);
    // Every WIP file change is preserved, staged.
    const staged = git(dir, ['diff', '--cached', '--name-only']).trim().split('\n').sort();
    assert.deepStrictEqual(staged, ['wip1.txt', 'wip2.txt', 'wip3.txt']);
    // Re-running detection is now a no-op (state-machine idempotency).
    const after = inDir(dir, () => detectWipSquash());
    assert.deepStrictEqual(after.commits, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runStashTransaction — the three pinned outcomes
// ---------------------------------------------------------------------------

function stubGit(handlers) {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push(args.join(' '));
    for (const [prefix, response] of handlers) {
      if (args.join(' ').startsWith(prefix)) return response;
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { spawnFn, calls };
}

test('runStashTransaction: happy path -> committed, no hook failure, no pop conflict', () => {
  const { spawnFn, calls } = stubGit([
    ['diff --name-only --diff-filter=U', { status: 0, stdout: '', stderr: '' }],
    ['diff --name-only', { status: 0, stdout: 'b.txt', stderr: '' }],
    ['stash push', { status: 0, stdout: 'Saved working directory and index state', stderr: '' }],
    ['stash pop', { status: 0, stdout: '', stderr: '' }],
  ]);
  const result = runStashTransaction(() => ({ status: 0, stdout: '', stderr: '' }), { spawnFn });
  assert.deepStrictEqual(result, { committed: true, hookFailed: false, popConflict: false });
  assert.ok(calls.some(c => c === 'stash push --keep-index -m commit-sdlc: temp stash'));
  assert.ok(calls.some(c => c === 'stash pop'));
});

test('runStashTransaction: hook failure -> not committed, stash deliberately left in place', () => {
  // `core.hooksPath` being set means detectPreCommitHook() -> hookPresent: true,
  // so an unrecognized failure message classifies as 'hook'.
  const { spawnFn, calls } = stubGit([
    ['diff --name-only', { status: 0, stdout: 'b.txt', stderr: '' }],
    ['stash push', { status: 0, stdout: 'Saved working directory and index state', stderr: '' }],
    ['config core.hooksPath', { status: 0, stdout: '.husky', stderr: '' }],
  ]);
  const result = runStashTransaction(
    () => ({ status: 1, stdout: '', stderr: 'eslint failed on 2 files' }),
    { spawnFn },
  );
  assert.strictEqual(result.committed, false);
  assert.strictEqual(result.hookFailed, true);
  assert.strictEqual(result.classification, 'hook');
  assert.strictEqual(result.popConflict, false);
  assert.strictEqual(result.reason, 'pre-commit hook exited non-zero');
  assert.match(result.detail, /eslint failed/);
  assert.ok(!calls.some(c => c === 'stash pop'), 'stash must survive a hook failure');
});

test('runStashTransaction: stash pop conflict -> committed with conflictFiles from the unmerged index', () => {
  const spawnFn = (cmd, args) => {
    const key = args.join(' ');
    if (key === 'diff --name-only') return { status: 0, stdout: 'a.js', stderr: '' };
    if (key.startsWith('stash push')) return { status: 0, stdout: 'Saved working directory', stderr: '' };
    if (key === 'stash pop') return { status: 1, stdout: '', stderr: 'CONFLICT' };
    if (key === 'diff --name-only --diff-filter=U') return { status: 0, stdout: 'path/a.js\npath/b.js', stderr: '' };
    throw new Error(`unexpected call: ${key}`);
  };
  const result = runStashTransaction(() => ({ status: 0, stdout: '', stderr: '' }), { spawnFn });
  assert.deepStrictEqual(result, {
    committed: true,
    hookFailed: false,
    popConflict: true,
    conflictFiles: ['path/a.js', 'path/b.js'],
  });
});

test('runStashTransaction: conflictFiles fall back to parsing git CONFLICT lines', () => {
  const spawnFn = (cmd, args) => {
    const key = args.join(' ');
    if (key === 'diff --name-only') return { status: 0, stdout: 'a.js', stderr: '' };
    if (key.startsWith('stash push')) return { status: 0, stdout: 'Saved working directory', stderr: '' };
    if (key === 'stash pop') {
      return {
        status: 1,
        stdout: 'CONFLICT (content): Merge conflict in src/a.js\nCONFLICT (content): Merge conflict in src/b.js',
        stderr: '',
      };
    }
    if (key === 'diff --name-only --diff-filter=U') return { status: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected call: ${key}`);
  };
  const result = runStashTransaction(() => ({ status: 0, stdout: '', stderr: '' }), { spawnFn });
  assert.strictEqual(result.popConflict, true);
  assert.deepStrictEqual(result.conflictFiles, ['src/a.js', 'src/b.js']);
});

test('runStashTransaction: no unstaged changes -> no stash push and no stash pop', () => {
  const { spawnFn, calls } = stubGit([
    ['diff --name-only', { status: 0, stdout: '', stderr: '' }],
  ]);
  const result = runStashTransaction(() => ({ status: 0, stdout: '', stderr: '' }), { spawnFn });
  assert.deepStrictEqual(result, { committed: true, hookFailed: false, popConflict: false });
  assert.ok(!calls.some(c => c.startsWith('stash')));
});

test('runStashTransaction: noStash skips the stash entirely', () => {
  const { spawnFn, calls } = stubGit([]);
  const result = runStashTransaction(() => ({ status: 0, stdout: '', stderr: '' }), { spawnFn, noStash: true });
  assert.deepStrictEqual(result, { committed: true, hookFailed: false, popConflict: false });
  assert.strictEqual(calls.length, 0);
});

test('runStashTransaction: git stash push failure aborts before the commit is attempted', () => {
  let commitCalled = false;
  const { spawnFn } = stubGit([
    ['diff --name-only', { status: 0, stdout: 'b.txt', stderr: '' }],
    ['stash push', { status: 1, stdout: '', stderr: 'fatal: unable to write' }],
  ]);
  const result = runStashTransaction(() => { commitCalled = true; return { status: 0 }; }, { spawnFn });
  assert.strictEqual(result.committed, false);
  assert.strictEqual(result.hookFailed, false);
  assert.strictEqual(result.popConflict, false);
  assert.match(result.reason, /git stash push failed/);
  assert.strictEqual(commitCalled, false);
});

// ---------------------------------------------------------------------------
// classifyCommitFailure — pure function, one case per classification
// ---------------------------------------------------------------------------

test('classifyCommitFailure: identity signature', () => {
  for (const detail of [
    'Author identity unknown\n*** Please tell me who you are.',
    '*** Please tell me who you are.\nRun git config --global user.email "you@example.com"',
  ]) {
    const result = classifyCommitFailure(detail, { hookPresent: true });
    assert.deepStrictEqual(result, { hookFailed: false, classification: 'identity' });
  }
  const fatalEmptyIdentCase = classifyCommitFailure(
    'fatal: empty ident name (for <you@example.com>) not allowed',
    { hookPresent: false },
  );
  assert.deepStrictEqual(fatalEmptyIdentCase, { hookFailed: false, classification: 'identity' });
  const fatalAutoDetectCase = classifyCommitFailure(
    'fatal: unable to auto-detect email address, please set it with the command above.',
    { hookPresent: false },
  );
  assert.deepStrictEqual(fatalAutoDetectCase, { hookFailed: false, classification: 'identity' });
});

test('classifyCommitFailure: anchored identity signature wins even when hookPresent is true', () => {
  const result = classifyCommitFailure('Author identity unknown\n*** Please tell me who you are.', { hookPresent: true });
  assert.deepStrictEqual(result, { hookFailed: false, classification: 'identity' });
});

test('classifyCommitFailure: bare "user.email" text from a hook does NOT override a present hook', () => {
  // A pre-commit hook (e.g. a config linter) can print "user.email" for
  // reasons unrelated to git identity — that wording is not in
  // FAILURE_SIGNATURES at all. With hookPresent: true this must classify as
  // 'hook' (not 'identity'), so the stash-recovery guidance
  // (commit.js:409-411) is not suppressed.
  const result = classifyCommitFailure('error: user.email field misspelled in config.yaml', { hookPresent: true });
  assert.deepStrictEqual(result, { hookFailed: true, classification: 'hook' });
});

test('classifyCommitFailure: husky "protected branch" text without remote: framing does NOT override a present hook', () => {
  // Husky/hook output can echo "protected branch" without git/GitHub's own
  // `remote:`-prefixed or GH006 framing. hookPresent: true must keep this as
  // 'hook', not misclassify it as 'protected-branch'.
  const result = classifyCommitFailure('ERROR: protected branch, cannot commit directly to main', { hookPresent: true });
  assert.deepStrictEqual(result, { hookFailed: true, classification: 'hook' });
});

test('classifyCommitFailure: gpg signature', () => {
  const result = classifyCommitFailure('error: gpg failed to sign the data', { hookPresent: true });
  assert.deepStrictEqual(result, { hookFailed: false, classification: 'gpg' });
});

test('classifyCommitFailure: nothing-to-commit signature', () => {
  const result = classifyCommitFailure('nothing to commit, working tree clean', { hookPresent: true });
  assert.deepStrictEqual(result, { hookFailed: false, classification: 'nothing-to-commit' });
});

test('classifyCommitFailure: nothing-to-commit signature — untracked-files wording', () => {
  const result = classifyCommitFailure(
    'nothing added to commit but untracked files present (use "git add" to track)',
    { hookPresent: true },
  );
  assert.deepStrictEqual(result, { hookFailed: false, classification: 'nothing-to-commit' });
});

test('classifyCommitFailure: protected-branch signature', () => {
  const result = classifyCommitFailure('remote: error: GH006: Protected branch update failed', { hookPresent: true });
  assert.deepStrictEqual(result, { hookFailed: false, classification: 'protected-branch' });
});

test('classifyCommitFailure: anchored signature wins even when hookPresent says otherwise', () => {
  const result = classifyCommitFailure('nothing to commit, working tree clean', { hookPresent: true });
  assert.strictEqual(result.classification, 'nothing-to-commit');
  assert.strictEqual(result.hookFailed, false);
});

test('classifyCommitFailure: unknown message + hookPresent true -> hook, hookFailed true', () => {
  const result = classifyCommitFailure('eslint failed on 2 files', { hookPresent: true });
  assert.deepStrictEqual(result, { hookFailed: true, classification: 'hook' });
});

test('classifyCommitFailure: unknown message + hookPresent false -> other, hookFailed false', () => {
  const result = classifyCommitFailure('eslint failed on 2 files', { hookPresent: false });
  assert.deepStrictEqual(result, { hookFailed: false, classification: 'other' });
});

test('classifyCommitFailure: unknown message + hookPresent undefined/null -> ambiguous, hookFailed true', () => {
  assert.deepStrictEqual(
    classifyCommitFailure('eslint failed on 2 files', {}),
    { hookFailed: true, classification: 'ambiguous' },
  );
  assert.deepStrictEqual(
    classifyCommitFailure('eslint failed on 2 files', { hookPresent: null }),
    { hookFailed: true, classification: 'ambiguous' },
  );
  assert.deepStrictEqual(
    classifyCommitFailure('eslint failed on 2 files'),
    { hookFailed: true, classification: 'ambiguous' },
  );
});

test('classifyCommitFailure: unanchored-looking text + hookPresent undefined -> ambiguous, not a guessed classification', () => {
  // hookPresent unknown means a hook's presence can't be ruled out, and
  // "user.email" is not an anchored signature, so the result is 'ambiguous'
  // — the same as any other unmatched text with hookPresent unknown.
  const result = classifyCommitFailure('error: user.email field misspelled in config.yaml', {});
  assert.deepStrictEqual(result, { hookFailed: true, classification: 'ambiguous' });
});

// ---------------------------------------------------------------------------
// detectPreCommitHook — injected execFn/fs
// ---------------------------------------------------------------------------

function fakeFs({ preCommitStat = null, huskyStat = null } = {}) {
  return {
    statSync: (p) => {
      if (p === '/repo/.git/hooks/pre-commit') {
        if (preCommitStat) return preCommitStat;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      if (p === '.husky/pre-commit') {
        if (huskyStat) return huskyStat;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      throw Object.assign(new Error(`unexpected statSync path: ${p}`), { code: 'ENOENT' });
    },
  };
}

const NO_HOOK_EXEC = (args) => {
  if (args[0] === 'config') return { status: 0, stdout: '', stderr: '' };
  if (args[0] === 'rev-parse') return { status: 0, stdout: '/repo/.git/hooks/pre-commit', stderr: '' };
  throw new Error(`unexpected exec: ${args.join(' ')}`);
};

test('detectPreCommitHook: core.hooksPath set -> true', () => {
  const execFn = (args) => {
    if (args[0] === 'config') return { status: 0, stdout: '.husky', stderr: '' };
    throw new Error('rev-parse should not be reached once core.hooksPath resolves');
  };
  assert.strictEqual(detectPreCommitHook({ execFn, fs: fakeFs() }), true);
});

test('detectPreCommitHook: <git-dir>/hooks/pre-commit exists and is executable -> true', () => {
  const executableStat = { isFile: () => true, mode: 0o100755 };
  assert.strictEqual(
    detectPreCommitHook({ execFn: NO_HOOK_EXEC, fs: fakeFs({ preCommitStat: executableStat }) }),
    true,
  );
});

test('detectPreCommitHook: <git-dir>/hooks/pre-commit exists but is not executable -> falls through to husky check', () => {
  const nonExecStat = { isFile: () => true, mode: 0o100644 };
  const huskyStat = { isFile: () => true, mode: 0o100755 };
  assert.strictEqual(
    detectPreCommitHook({ execFn: NO_HOOK_EXEC, fs: fakeFs({ preCommitStat: nonExecStat, huskyStat }) }),
    true,
  );
  assert.strictEqual(
    detectPreCommitHook({ execFn: NO_HOOK_EXEC, fs: fakeFs({ preCommitStat: nonExecStat }) }),
    false,
  );
});

test('detectPreCommitHook: .husky/pre-commit exists -> true', () => {
  const huskyStat = { isFile: () => true, mode: 0o100755 };
  assert.strictEqual(
    detectPreCommitHook({ execFn: NO_HOOK_EXEC, fs: fakeFs({ huskyStat }) }),
    true,
  );
});

test('detectPreCommitHook: none of core.hooksPath / hooks/pre-commit / .husky/pre-commit -> false', () => {
  assert.strictEqual(detectPreCommitHook({ execFn: NO_HOOK_EXEC, fs: fakeFs() }), false);
});

// ---------------------------------------------------------------------------
// runStashTransaction — classification wired through the failure path
// ---------------------------------------------------------------------------

test('runStashTransaction: identity failure classification', () => {
  const { spawnFn } = stubGit([]);
  const result = runStashTransaction(
    () => ({ status: 128, stdout: '', stderr: '*** Please tell me who you are.\nfatal: unable to auto-detect email' }),
    { spawnFn, noStash: true },
  );
  assert.strictEqual(result.committed, false);
  assert.strictEqual(result.hookFailed, false);
  assert.strictEqual(result.classification, 'identity');
  assert.match(result.reason, /identity/);
  assert.match(result.detail, /Please tell me who you are/);
});

test('runStashTransaction: gpg failure classification', () => {
  const { spawnFn } = stubGit([]);
  const result = runStashTransaction(
    () => ({ status: 128, stdout: '', stderr: 'error: gpg failed to sign the data' }),
    { spawnFn, noStash: true },
  );
  assert.strictEqual(result.hookFailed, false);
  assert.strictEqual(result.classification, 'gpg');
});

test('runStashTransaction: nothing-to-commit failure classification', () => {
  const { spawnFn } = stubGit([]);
  const result = runStashTransaction(
    () => ({ status: 1, stdout: 'nothing to commit, working tree clean', stderr: '' }),
    { spawnFn, noStash: true },
  );
  assert.strictEqual(result.hookFailed, false);
  assert.strictEqual(result.classification, 'nothing-to-commit');
});

test('runStashTransaction: protected-branch failure classification', () => {
  const { spawnFn } = stubGit([]);
  const result = runStashTransaction(
    () => ({ status: 1, stdout: '', stderr: 'remote: error: protected branch hook declined' }),
    { spawnFn, noStash: true },
  );
  assert.strictEqual(result.hookFailed, false);
  assert.strictEqual(result.classification, 'protected-branch');
});

test('runStashTransaction: unrecognized failure + no hook detected -> other, hookFailed false', () => {
  const { spawnFn } = stubGit([]); // default handler answers config/rev-parse with empty results
  const noFilesFs = { statSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
  const result = runStashTransaction(
    () => ({ status: 1, stdout: '', stderr: 'some unexplained failure' }),
    { spawnFn, noStash: true, fs: noFilesFs },
  );
  assert.strictEqual(result.hookFailed, false);
  assert.strictEqual(result.classification, 'other');
  assert.strictEqual(result.reason, 'git commit failed');
});

test('runStashTransaction: ambiguous classification when hook detection itself throws', () => {
  const spawnFn = () => { throw new Error('spawn boom'); };
  const result = runStashTransaction(
    () => ({ status: 1, stdout: '', stderr: 'some unexplained failure' }),
    { spawnFn, noStash: true },
  );
  assert.strictEqual(result.hookFailed, true);
  assert.strictEqual(result.classification, 'ambiguous');
  assert.strictEqual(result.reason, 'pre-commit hook exited non-zero');
});

// ---------------------------------------------------------------------------
// CLI end-to-end
// ---------------------------------------------------------------------------

test('CLI --squash-execute resolves the fork-point itself and squashes the WIP commits', () => {
  const { dir, forkPoint } = makeRepoWithWip(2);
  try {
    const result = runCli(dir, ['--squash-execute']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), { status: 'squashed', forkPoint });
    assert.strictEqual(git(dir, ['rev-parse', 'HEAD']).trim(), forkPoint);
    assert.strictEqual(git(dir, ['diff', '--cached', '--name-only']).trim().split('\n').length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --squash-execute honours an explicit --fork-point from the detection output', () => {
  const { dir, forkPoint } = makeRepoWithWip(2);
  try {
    const result = runCli(dir, ['--squash-execute', '--fork-point', forkPoint]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), { status: 'squashed', forkPoint });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --stash-transaction commits and restores the stash', () => {
  const { dir } = makeRepoWithWip(0);
  try {
    fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n');
    git(dir, ['add', 'staged.txt']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'unstaged edit\n');

    const result = runCli(dir, ['--stash-transaction', '--message', 'feat: add staged file']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), {
      committed: true, hookFailed: false, popConflict: false,
    });
    assert.match(git(dir, ['log', '-1', '--format=%s']).trim(), /^feat: add staged file$/);
    // Stash was popped: the unstaged edit is back and no stash remains.
    assert.strictEqual(fs.readFileSync(path.join(dir, 'base.txt'), 'utf8'), 'unstaged edit\n');
    assert.strictEqual(git(dir, ['stash', 'list']).trim(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI default mode: recent-commit sample is git log -15, not -5', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-log15-')));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    for (let i = 1; i <= 20; i++) {
      fs.writeFileSync(path.join(dir, `c${i}.txt`), `c${i}\n`);
      git(dir, ['add', '.']);
      git(dir, ['commit', '-q', '-m', `chore: commit ${i}`]);
    }
    // Off the default branch so the default-branch guard doesn't short-circuit anything.
    git(dir, ['checkout', '-q', '-b', 'feature/log15']);
    fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n');
    git(dir, ['add', 'staged.txt']);

    const result = runCli(dir, ['--skip-config-check']);
    const manifestPath = result.stdout.trim().split('\n').pop();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(manifest.recentCommits.length, 15, result.stderr);
    assert.match(manifest.recentCommits[0], /chore: commit 20$/);
    assert.match(manifest.recentCommits[14], /chore: commit 6$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --stash-transaction without --message exits 1 with a structured reason', () => {
  const { dir } = makeRepoWithWip(0);
  try {
    const result = runCli(dir, ['--stash-transaction']);
    assert.strictEqual(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.committed, false);
    assert.match(parsed.reason, /--message/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
