#!/usr/bin/env node
/**
 * version-execute.js — version-sdlc write-side git transactions.
 *
 * Offloads three inline git sequences from `skills/version-sdlc/SKILL.md`
 * (and `resources/changelog-workflow.md`) into deterministic, testable
 * subcommands so the SKILL stops running multi-step, non-atomic git
 * sequences inline:
 *
 *   - `retag`           — Branch D, Step D3: the five-command retag sequence,
 *                         made atomic by recreating the deleted local tag when
 *                         the re-push fails.
 *   - `release`         — Branch B, Step 8: version-file diff gate, stage,
 *                         commit, annotated tag, two-command push, with a
 *                         tag rollback when the post-tag push fails.
 *   - `changelog-commit`— Branch C, Step 7: stage/commit/push the changelog
 *                         without creating a tag.
 *
 * Usage:
 *   node version-execute.js retag --tag <name> [--expected-head <sha>]
 *   node version-execute.js release --tag <name> [--hotfix] [--version-file <path>]
 *                                   [--changelog-file <path>] [--no-push]
 *                                   [--set-upstream <branch>]
 *   node version-execute.js changelog-commit [--tag <name>] [--changelog-file <path>]
 *                                            [--no-push]
 *
 * Output (stdout, one JSON line via writeJsonLine()):
 *   retag, success:  {"status":"ok","tag":"v1.2.3"}
 *   retag, failure:  {"status":"failed","recovered":true,"failedStep":"push",
 *                     "reason":"push rejected: non-fast-forward"}
 *   retag, verify failure (--expected-head given and the tag lands elsewhere):
 *                    {"status":"failed","failedStep":"verify",
 *                     "reason":"tag points at abc1234, approved head was def5678"}
 *   release, success:{"status":"ok","tag":"v1.2.3"}
 *   release, push failure:      {"status":"failed","rolledBackTag":true,"failedStep":"push",
 *                                "reason":"push rejected: non-fast-forward — local tag v1.2.3
 *                                          deleted to keep repo state consistent"}
 *   release, push-tags failure: {"status":"failed","rolledBackTag":false,"failedStep":"push-tags",
 *                                "reason":"push rejected: non-fast-forward — release commit is
 *                                          already on origin; local tag v1.2.3 kept",
 *                                "recovery":"git push origin v1.2.3"}
 *   changelog-commit:{"status":"ok"} | {"status":"failed","reason":"..."}
 *
 * Exit codes:
 *   0 = status "ok"
 *   1 = status "failed", or a missing required argument
 *   2 = unknown subcommand / unexpected crash
 *
 * Rollback contract:
 *   - `retag` never leaves the repo in the "local tag deleted, remote tag also
 *     gone" state: any failure after the local delete recreates the local tag
 *     at the SHA it pointed to before the retag started, so a plain
 *     `git push origin <tag>` restores the original remote state.
 *   - `release` reports a failure with its own `rolledBackTag` field rather
 *     than reusing `retag`'s `recovered` field — the two failure modes
 *     recover different things. A failure on the release-commit push (before
 *     the tag reaches the remote) deletes the just-created local tag
 *     (`rolledBackTag: true`); a failure on the tag push (after the release
 *     commit is already on the remote) keeps the local tag — deleting it
 *     would strand the release with no recovery handle, since the
 *     version-file gate refuses a re-run once the bump has landed — and
 *     returns `rolledBackTag: false` plus a `recovery` field with the exact
 *     `git push <remote> <tag>` command to finish the release.
 *
 * `spawnFn` is injectable on every exported core function so tests never need
 * a real git repo or remote. Runs in the current cwd (not resolveSdlcRoot()),
 * matching the other new util scripts, so the git ops land in the active
 * worktree.
 *
 * Uses only Node.js built-in modules. No npm install required.
 */
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');
const { writeJsonLine } = require(path.join(LIB, 'output'));

const DEFAULT_REMOTE = 'origin';
const DEFAULT_CHANGELOG_FILE = 'CHANGELOG.md';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command and normalize its result. Mirrors
 * rebase-onto-base.js / ship-git-ops.js's spawnSync result normalization.
 */
function run(spawnFn, cmdArgs, cwd) {
  const result = spawnFn('git', cmdArgs, { cwd, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

/** Best-effort human-readable failure text for a normalized git result. */
function errorText(result) {
  return result.stderr || result.stdout || `git exited ${result.status}`;
}

/**
 * Count added/removed content lines in a unified diff, ignoring the
 * `---`/`+++` file headers.
 * @param {string} diffText
 * @returns {{added: number, removed: number}}
 */
function countDiffLines(diffText) {
  let added = 0;
  let removed = 0;
  for (const line of (diffText || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

// ---------------------------------------------------------------------------
// retag
// ---------------------------------------------------------------------------

/**
 * Recreate the local tag at `sha`, restoring the pre-retag local state.
 *
 * `git tag -a` is given an explicit `-m` so it never opens an editor — an
 * interactive prompt here would hang the recovery path.
 *
 * The leading `git tag -d` is a no-op when the tag is already gone (the
 * common case) and removes the newly-created HEAD tag when the re-push
 * failed; its exit status is deliberately ignored.
 *
 * @returns {boolean} true when the tag now exists at `sha`.
 */
function recreateLocalTag(spawnFn, cwd, tag, sha, message) {
  if (!sha) return false;
  run(spawnFn, ['tag', '-d', tag], cwd);
  const result = run(spawnFn, ['tag', '-a', tag, '-m', message, sha], cwd);
  return result.status === 0;
}

/**
 * Move an existing tag to HEAD atomically.
 *
 * Sequence (SKILL.md Branch D, Step D3):
 *   1. `git tag -d <tag>`
 *   2. `git push <remote> :refs/tags/<tag>`
 *   3. `git tag -a <tag> -m "Retag <tag>"`   (at HEAD)
 *   4. `git push <remote> <tag>`
 *   5. `git rev-parse refs/tags/<tag>^{commit}` — verify it now points to HEAD
 *
 * Any failure at steps 2-4 recreates the local tag at its original SHA before
 * reporting, closing the non-atomic gap where both the local and the remote
 * tag are gone.
 *
 * When `expectedHead` is passed (the `head` SHA from the prepare output the
 * user actually approved), step 5 verifies against that captured value
 * instead of a freshly re-derived `HEAD` — HEAD can move between approval and
 * execution (e.g. a concurrent push), so re-deriving it at verify time could
 * silently confirm a retag against a commit the user never approved. A
 * mismatch is then a hard failure (`failedStep: 'verify'`), not the advisory
 * warning used when `expectedHead` is omitted.
 *
 * @param {string} tag
 * @param {{spawnFn?: Function, cwd?: string, remote?: string, message?: string,
 *          expectedHead?: string|null}} [opts]
 * @returns {{status: 'ok', tag: string, verified?: false, warning?: string}
 *          |{status: 'failed', recovered: boolean, failedStep: string, reason: string}
 *          |{status: 'failed', failedStep: 'verify', reason: string}}
 */
function runRetag(tag, { spawnFn = spawnSync, cwd = process.cwd(), remote = DEFAULT_REMOTE, message, expectedHead = null } = {}) {
  const tagMessage = message || `Retag ${tag}`;

  // Capture the SHA before anything is deleted — it is the recovery target.
  const oldShaResult = run(spawnFn, ['rev-parse', `${tag}^{commit}`], cwd);
  const oldSha = oldShaResult.status === 0 ? oldShaResult.stdout : '';

  const fail = (failedStep, reason) => ({
    status: 'failed',
    recovered: recreateLocalTag(spawnFn, cwd, tag, oldSha, tagMessage),
    failedStep,
    reason,
  });

  // 1. Delete the local tag. Nothing has changed yet if this fails.
  const deleteLocal = run(spawnFn, ['tag', '-d', tag], cwd);
  if (deleteLocal.status !== 0) {
    return { status: 'failed', recovered: false, failedStep: 'tag-delete', reason: errorText(deleteLocal) };
  }

  // 2. Delete the remote tag.
  const deleteRemote = run(spawnFn, ['push', remote, `:refs/tags/${tag}`], cwd);
  if (deleteRemote.status !== 0) {
    return fail('push-delete', errorText(deleteRemote));
  }

  // 3. Recreate the annotated tag at HEAD.
  const createTag = run(spawnFn, ['tag', '-a', tag, '-m', tagMessage], cwd);
  if (createTag.status !== 0) {
    return fail('tag-create', errorText(createTag));
  }

  // 4. Push the new tag.
  const pushTag = run(spawnFn, ['push', remote, tag], cwd);
  if (pushTag.status !== 0) {
    return fail('push', errorText(pushTag));
  }

  // 5. Verify. When the caller supplied the approved head, compare against
  //    that captured SHA — a mismatch means the tag landed somewhere other
  //    than what the user approved, which is a hard failure. Without it,
  //    fall back to a freshly re-derived HEAD, where a mismatch is only a
  //    warning — the retag itself succeeded and the user can inspect manually.
  const tagSha = run(spawnFn, ['rev-parse', `refs/tags/${tag}^{commit}`], cwd);

  if (expectedHead) {
    if (tagSha.status !== 0 || tagSha.stdout !== expectedHead) {
      return {
        status: 'failed',
        failedStep: 'verify',
        reason: `tag points at ${tagSha.stdout || 'unknown'}, approved head was ${expectedHead}`,
      };
    }
    return { status: 'ok', tag };
  }

  const headSha = run(spawnFn, ['rev-parse', 'HEAD'], cwd);
  if (tagSha.status !== 0 || headSha.status !== 0 || tagSha.stdout !== headSha.stdout) {
    return {
      status: 'ok',
      tag,
      verified: false,
      warning: `tag ${tag} resolves to ${tagSha.stdout || 'unknown'} but HEAD is ${headSha.stdout || 'unknown'}`,
    };
  }

  return { status: 'ok', tag };
}

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

/**
 * Version-file rollback gate (SKILL.md Step 8.1): exactly one line of
 * `<versionFile>` may differ. Anything else restores the file with
 * `git checkout -- <versionFile>` and aborts the release.
 *
 * @returns {null|{status: 'failed', failedStep: string, reason: string, restoredVersionFile: boolean, diff: string}}
 */
function checkVersionFileGate(spawnFn, cwd, versionFile) {
  const diffResult = run(spawnFn, ['diff', '--', versionFile], cwd);
  if (diffResult.status !== 0) {
    return {
      status: 'failed',
      failedStep: 'diff-gate',
      reason: errorText(diffResult),
      restoredVersionFile: false,
      diff: '',
    };
  }

  const { added, removed } = countDiffLines(diffResult.stdout);
  if (added === 1 && removed === 1) return null;

  // Nothing changed — no edit landed, and there is nothing to restore.
  if (added === 0 && removed === 0) {
    return {
      status: 'failed',
      failedStep: 'diff-gate',
      reason: `version-file gate: no changes detected in ${versionFile} — the version edit did not land`,
      restoredVersionFile: false,
      diff: '',
    };
  }

  const checkout = run(spawnFn, ['checkout', '--', versionFile], cwd);
  return {
    status: 'failed',
    failedStep: 'diff-gate',
    reason:
      `version-file gate: ${added} added / ${removed} removed line(s) in ${versionFile}, ` +
      'expected exactly one changed line',
    restoredVersionFile: checkout.status === 0,
    diff: diffResult.stdout,
  };
}

/**
 * Execute the release transaction (SKILL.md Branch B, Step 8):
 * diff gate → `git add` → `git commit` → `git tag -a` → two-command push.
 *
 * A push failure *after* the tag was created deletes the tag again and is
 * reported with `rolledBackTag`, so the repo never keeps a local tag whose
 * release commit is unreachable from the remote.
 *
 * @param {string} tag
 * @param {{hotfix?: boolean, versionFile?: string|null, changelogFile?: string|null,
 *          noPush?: boolean, upstreamBranch?: string|null, remote?: string,
 *          spawnFn?: Function, cwd?: string}} [opts]
 * @returns {{status: 'ok', tag: string, pushed?: false}
 *          |{status: 'failed', failedStep: string, reason: string, rolledBackTag?: boolean, recovery?: string, restoredVersionFile?: boolean, diff?: string}}
 */
function runRelease(tag, opts = {}) {
  const {
    hotfix = false,
    versionFile = null,
    changelogFile = null,
    noPush = false,
    upstreamBranch = null,
    remote = DEFAULT_REMOTE,
    spawnFn = spawnSync,
    cwd = process.cwd(),
  } = opts;

  // 1. Rollback gate on the version file (skipped in tag mode, where there is
  //    no version file to edit).
  if (versionFile) {
    const gateFailure = checkVersionFileGate(spawnFn, cwd, versionFile);
    if (gateFailure) return gateFailure;
  }

  // 2. Stage only the files that were actually changed.
  const files = [versionFile, changelogFile].filter(Boolean);
  if (files.length === 0) {
    return {
      status: 'failed',
      failedStep: 'add',
      reason: 'no files to stage: pass --version-file and/or --changelog-file',
    };
  }

  const addResult = run(spawnFn, ['add', ...files], cwd);
  if (addResult.status !== 0) {
    return { status: 'failed', failedStep: 'add', reason: errorText(addResult) };
  }

  // 3. Commit.
  const commitMessage = hotfix ? `chore(release): ${tag} [hotfix]` : `chore(release): ${tag}`;
  const commitResult = run(spawnFn, ['commit', '-m', commitMessage], cwd);
  if (commitResult.status !== 0) {
    return { status: 'failed', failedStep: 'commit', reason: errorText(commitResult) };
  }

  // 4. Annotated tag — hotfix releases carry a `Type: hotfix` trailer.
  const tagMessage = hotfix ? `Release ${tag}\n\nType: hotfix` : `Release ${tag}`;
  const tagResult = run(spawnFn, ['tag', '-a', tag, '-m', tagMessage], cwd);
  if (tagResult.status !== 0) {
    return { status: 'failed', failedStep: 'tag', reason: errorText(tagResult) };
  }

  if (noPush) {
    return { status: 'ok', tag, pushed: false };
  }

  // 5. Two-command push: the release commit, then the tag. `git push <tag>`
  //    alone does NOT push the release commit — both are required.
  //
  //    `rollbackTag` is only used for the pre-push failure below: once the
  //    release commit push has succeeded, the commit is on the remote and
  //    the local tag must never be deleted — it is the only recovery handle,
  //    since the version-file gate makes a re-run of the release impossible.
  const rollbackTag = (failedStep, reason) => {
    const deleteResult = run(spawnFn, ['tag', '-d', tag], cwd);
    return {
      status: 'failed',
      rolledBackTag: deleteResult.status === 0,
      failedStep,
      reason: `${reason} — local tag ${tag} deleted to keep repo state consistent`,
    };
  };

  const commitPushArgs = upstreamBranch
    ? ['push', '--set-upstream', remote, upstreamBranch]
    : ['push'];
  const commitPush = run(spawnFn, commitPushArgs, cwd);
  if (commitPush.status !== 0) {
    return rollbackTag('push', errorText(commitPush));
  }

  // Explicit single-tag push (mirrors runRetag's push at :183) so unrelated
  // local tags are never pushed as a side effect.
  const tagPush = run(spawnFn, ['push', remote, tag], cwd);
  if (tagPush.status !== 0) {
    // The release commit already landed on the remote — deleting the local
    // tag here would strand it with no way to recover, since the version-file
    // gate refuses a re-run once the bump has landed. Keep the tag and hand
    // back the exact recovery command instead.
    return {
      status: 'failed',
      rolledBackTag: false,
      failedStep: 'push-tags',
      reason: `${errorText(tagPush)} — release commit is already on ${remote}; local tag ${tag} kept`,
      recovery: `git push ${remote} ${tag}`,
    };
  }

  return { status: 'ok', tag };
}

// ---------------------------------------------------------------------------
// changelog-commit
// ---------------------------------------------------------------------------

/**
 * Stage, commit and push a changelog-only update
 * (resources/changelog-workflow.md, Step 7). Creates no tag.
 *
 * @param {{tag?: string|null, changelogFile?: string, noPush?: boolean,
 *          spawnFn?: Function, cwd?: string}} [opts]
 * @returns {{status: 'ok', pushed?: false}
 *          |{status: 'failed', failedStep: string, reason: string, committed?: boolean, pushed?: false}}
 */
function runChangelogCommit(opts = {}) {
  const {
    tag = null,
    changelogFile = DEFAULT_CHANGELOG_FILE,
    noPush = false,
    spawnFn = spawnSync,
    cwd = process.cwd(),
  } = opts;

  const addResult = run(spawnFn, ['add', changelogFile], cwd);
  if (addResult.status !== 0) {
    return { status: 'failed', failedStep: 'add', reason: errorText(addResult) };
  }

  const message = tag ? `docs: update changelog for ${tag}` : 'docs: update changelog';
  const commitResult = run(spawnFn, ['commit', '-m', message], cwd);
  if (commitResult.status !== 0) {
    return { status: 'failed', failedStep: 'commit', reason: errorText(commitResult) };
  }

  if (noPush) {
    return { status: 'ok', pushed: false };
  }

  const pushResult = run(spawnFn, ['push'], cwd);
  if (pushResult.status !== 0) {
    // The commit landed locally; only the push is missing.
    return {
      status: 'failed',
      failedStep: 'push',
      reason: errorText(pushResult),
      committed: true,
      pushed: false,
    };
  }

  return { status: 'ok' };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Manual argv parser — mirrors the `parseArgs` loop convention used across
 * `scripts/state/execute.js` and sibling `scripts/util/*.js` CLIs.
 * @param {string[]} argv  Full argv (`process.argv` shape).
 * @returns {{subcommand: string|null, tag: string|null, hotfix: boolean,
 *            versionFile: string|null, changelogFile: string|null,
 *            noPush: boolean, upstreamBranch: string|null, expectedHead: string|null}}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    subcommand: args[0] || null,
    tag: null,
    hotfix: false,
    versionFile: null,
    changelogFile: null,
    noPush: false,
    upstreamBranch: null,
    expectedHead: null,
  };

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--tag' && args[i + 1]) {
      result.tag = args[++i];
    } else if (a === '--hotfix') {
      result.hotfix = true;
    } else if (a === '--version-file' && args[i + 1]) {
      result.versionFile = args[++i];
    } else if (a === '--changelog-file' && args[i + 1]) {
      result.changelogFile = args[++i];
    } else if (a === '--no-push') {
      result.noPush = true;
    } else if (a === '--set-upstream' && args[i + 1]) {
      result.upstreamBranch = args[++i];
    } else if (a === '--expected-head' && args[i + 1]) {
      result.expectedHead = args[++i];
    }
  }

  return result;
}

function usage() {
  return (
    'Usage:\n' +
    '  version-execute.js retag --tag <name> [--expected-head <sha>]\n' +
    '  version-execute.js release --tag <name> [--hotfix] [--version-file <path>]\n' +
    '                             [--changelog-file <path>] [--no-push] [--set-upstream <branch>]\n' +
    '  version-execute.js changelog-commit [--tag <name>] [--changelog-file <path>] [--no-push]\n'
  );
}

function cmdRetag(opts) {
  if (!opts.tag) {
    writeJsonLine({ status: 'failed', reason: 'Missing required argument: --tag <name>' }, { exitCode: 1 });
    return;
  }
  const result = runRetag(opts.tag, { expectedHead: opts.expectedHead });
  writeJsonLine(result, { exitCode: result.status === 'ok' ? 0 : 1 });
}

function cmdRelease(opts) {
  if (!opts.tag) {
    writeJsonLine({ status: 'failed', reason: 'Missing required argument: --tag <name>' }, { exitCode: 1 });
    return;
  }
  const result = runRelease(opts.tag, {
    hotfix: opts.hotfix,
    versionFile: opts.versionFile,
    changelogFile: opts.changelogFile,
    noPush: opts.noPush,
    upstreamBranch: opts.upstreamBranch,
  });
  writeJsonLine(result, { exitCode: result.status === 'ok' ? 0 : 1 });
}

function cmdChangelogCommit(opts) {
  const result = runChangelogCommit({
    tag: opts.tag,
    changelogFile: opts.changelogFile || DEFAULT_CHANGELOG_FILE,
    noPush: opts.noPush,
  });
  writeJsonLine(result, { exitCode: result.status === 'ok' ? 0 : 1 });
}

/**
 * Subcommand dispatch — mirrors the `switch (opts.subcommand)` pattern at
 * the bottom of `scripts/util/worktree-lifecycle.js`.
 * @param {string[]} argv  Full argv (`process.argv` shape).
 */
function main(argv) {
  const opts = parseArgs(argv);

  switch (opts.subcommand) {
    case 'retag': cmdRetag(opts); break;
    case 'release': cmdRelease(opts); break;
    case 'changelog-commit': cmdChangelogCommit(opts); break;
    default:
      process.stderr.write(`Error: unknown subcommand "${opts.subcommand}"\n`);
      process.stderr.write(usage());
      process.exit(2);
  }
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stdout.write(JSON.stringify({ status: 'failed', reason: `Unexpected error: ${err.message}` }) + '\n');
    process.exit(2);
  }
}

module.exports = {
  parseArgs,
  countDiffLines,
  recreateLocalTag,
  checkVersionFileGate,
  runRetag,
  runRelease,
  runChangelogCommit,
  main,
};
