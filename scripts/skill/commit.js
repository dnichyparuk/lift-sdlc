#!/usr/bin/env node
/**
 * commit-prepare.js
 * Pre-computes all data needed for the commit-sdlc skill:
 * staged/unstaged state, diff content, recent commit history, and flag overrides.
 * Outputs JSON to stdout so the LLM can focus solely on message generation.
 *
 * Usage:
 *   node commit-prepare.js [options]
 *   node commit-prepare.js --squash-execute [--fork-point <sha>]
 *   node commit-prepare.js --stash-transaction --message <msg> [--amend] [--no-stash]
 *
 * Options:
 *   --no-stash       Skip stashing unstaged changes (passed through to output;
 *                    also honoured by --stash-transaction)
 *   --scope <s>      Override conventional commit scope (passed through to output)
 *   --type <t>       Override conventional commit type (passed through to output)
 *   --amend          Amend last commit instead of creating new (passed through to output;
 *                    also honoured by --stash-transaction)
 *   --auto           Skip interactive approval prompts (passed through to output)
 *   --no-squash-wip  Preserve `wip(execute):` commits instead of soft-resetting them
 *                    into the final commit (Fixes #392 / R35; passed through to output)
 *
 * Execution modes (one JSON line on stdout via writeJsonLine, not a manifest path):
 *   --squash-execute      Perform the wip(execute): squash — `git reset --soft <forkPoint>`
 *                         + `git add -A`. The fork-point is ALWAYS the value
 *                         `detectWipSquash()` resolved: either passed back verbatim via
 *                         `--fork-point <sha>` (read from this script's own detection
 *                         output) or recomputed by calling `detectWipSquash()` here.
 *                         It is never re-derived from a separate merge-base command, and
 *                         never from the broken `git symbolic-ref --short HEAD`
 *                         current-branch-name fallback (that made merge-base a no-op and
 *                         let WIP commits silently survive the squash).
 *   --stash-transaction   Run the stash → commit → stash-pop transaction and emit the
 *                         `{committed, hookFailed, popConflict}` outcome. Requires
 *                         `--message <msg>`.
 *
 * Exit codes:
 *   0 = success, JSON on stdout
 *   1 = fatal error, JSON with non-empty errors[] on stdout
 *   2 = unexpected script crash, message on stderr
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const LIB = path.join(__dirname, '..', 'lib');

const { exec, checkGitState, splitDiffByFile } = require(path.join(LIB, 'git'));
const { readSection, resolveSdlcRoot } = require(path.join(LIB, 'config'));
const { writeOutput, writeJsonLine } = require(path.join(LIB, 'output'));
const { writeManifestState } = require(path.join(LIB, 'state'));
const { resolveSkipConfigCheck, ensureConfigVersion } = require(path.join(LIB, 'config-version-prepare'));
const { truncateDiff } = require(path.join(LIB, 'diff-truncate'));
const { validateExpectedBranch } = require(path.join(LIB, 'branch-guard'));

// ---------------------------------------------------------------------------
// Diff truncation
// ---------------------------------------------------------------------------

const MAX_DIFF_CHARS = 8000;

/**
 * Truncates a staged diff to MAX_DIFF_CHARS using `lib/diff-truncate.js`,
 * which is the single canonical source of large-input cap policy in the
 * corpus (issue #284, task 20). Behaviour preserved 1:1 from the previous
 * inline implementation; the helper takes `splitDiffByFile` as an injected
 * dependency to avoid a circular `lib/git.js` import.
 *
 * @param {string} fullDiff
 * @returns {{ diff: string, diffTruncated: boolean, truncatedFiles: string[] }}
 */
function truncateStagedDiff(fullDiff) {
  return truncateDiff(fullDiff, { splitDiffByFile, maxBytes: MAX_DIFF_CHARS });
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let noStash             = false;
  let scope               = null;
  let type                = null;
  let amend               = false;
  let auto                = false;
  let noSquashWip         = false;
  let expectedBranch      = null;
  let forceDefaultBranch  = false;
  let squashExecute       = false;
  let stashTransaction    = false;
  let forkPoint           = null;
  let message             = null;
  const warnings = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-stash') {
      noStash = true;
    } else if (a === '--amend') {
      amend = true;
    } else if (a === '--scope' && args[i + 1]) {
      scope = args[++i];
    } else if (a === '--type' && args[i + 1]) {
      type = args[++i];
    } else if (a === '--auto') {
      auto = true;
    } else if (a === '--no-squash-wip') {
      noSquashWip = true;
    } else if (a === '--expected-branch' && args[i + 1]) {
      // R-expected-branch (issues #347, #348, #349): validated after gitState is resolved
      expectedBranch = args[++i];
    } else if (a === '--force-default-branch') {
      forceDefaultBranch = true;
    } else if (a === '--squash-execute') {
      squashExecute = true;
    } else if (a === '--stash-transaction') {
      stashTransaction = true;
    } else if (a === '--fork-point' && args[i + 1]) {
      forkPoint = args[++i];
    } else if (a === '--message' && args[i + 1]) {
      message = args[++i];
    }
  }

  return {
    noStash, scope, type, amend, auto, noSquashWip, expectedBranch, forceDefaultBranch,
    squashExecute, stashTransaction, forkPoint, message, warnings,
  };
}

// ---------------------------------------------------------------------------
// Default-branch resolution helper (R14, fixes #398)
// ---------------------------------------------------------------------------

function resolveDefaultBranch() {
  let defaultBranch = exec('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null', { cwd: process.cwd() });
  if (defaultBranch) defaultBranch = defaultBranch.trim().replace(/^refs\/remotes\/origin\//, '');
  if (!defaultBranch) {
    // Fall back: try 'main' then 'master'
    const mainExists = exec('git rev-parse --verify main 2>/dev/null', { cwd: process.cwd() });
    defaultBranch = mainExists ? 'main' : 'master';
  }
  return defaultBranch;
}

// ---------------------------------------------------------------------------
// WIP-commit squash detection (Fixes #392 / R35)
// ---------------------------------------------------------------------------

/**
 * Detects `wip(execute):` commits between the current branch's fork-point and HEAD.
 * Returns { commits: string[], stagedClean: boolean, forkPoint: string|null } —
 * consumed by commit-sdlc SKILL.md Step 1c to decide whether to soft-reset before
 * generating the final commit message.
 *
 * `forkPoint` is the resolved commit-ish the squash must reset to. It is surfaced
 * (rather than left internal) so the execution path — `runSquash()` /
 * `--squash-execute` — resets to the *same* value detection used. Detection and
 * execution can therefore never diverge: no consumer constructs its own
 * merge-base command.
 *
 * Fork-point resolution order (DO NOT alter — execution reuses it verbatim):
 *   1. `git merge-base HEAD <upstream>` when an upstream is configured
 *   2. Detected default branch (origin/HEAD symbolic ref → main/master fallback)
 *   3. When neither resolves, returns forkPoint: null and commits: [] — never errors
 */
function detectWipSquash() {
  const stagedRaw = exec('git diff --cached --name-only', { cwd: process.cwd() });
  const stagedClean = !stagedRaw || stagedRaw.split('\n').filter(Boolean).length === 0;

  let forkPoint = null;

  // Try upstream first.
  const upstream = exec('git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null', { cwd: process.cwd() });
  if (upstream && upstream.trim().length > 0) {
    const base = exec(`git merge-base HEAD ${upstream.trim()} 2>/dev/null`, { cwd: process.cwd() });
    if (base && base.trim().length > 0) forkPoint = base.trim();
  }

  // Fall back to detected default branch.
  if (!forkPoint) {
    const defaultBranch = resolveDefaultBranch();
    const base = exec(`git merge-base HEAD ${defaultBranch} 2>/dev/null`, { cwd: process.cwd() })
              || exec(`git merge-base HEAD master 2>/dev/null`, { cwd: process.cwd() });
    if (base && base.trim().length > 0) forkPoint = base.trim();
  }

  if (!forkPoint) {
    return { commits: [], stagedClean, forkPoint: null };
  }

  const logRaw = exec(`git log --format=%H%x09%s ${forkPoint}..HEAD`, { cwd: process.cwd() });
  if (!logRaw) return { commits: [], stagedClean, forkPoint };

  const wipPrefixRe = /^wip\(execute\)/;
  const commits = logRaw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const tabIdx = line.indexOf('\t');
      if (tabIdx < 0) return null;
      return { sha: line.slice(0, tabIdx), subject: line.slice(tabIdx + 1) };
    })
    .filter(e => e && wipPrefixRe.test(e.subject))
    .map(e => e.sha);

  return { commits, stagedClean, forkPoint };
}

// ---------------------------------------------------------------------------
// Squash execution + stash transaction (Task 5)
// ---------------------------------------------------------------------------

/**
 * Run a git command and normalize its result. Mirrors the spawnSync result
 * normalization used by scripts/util/rollback-stash.js.
 *
 * @param {Function} spawnFn
 * @param {string[]} cmdArgs
 * @param {string} cwd
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runGit(spawnFn, cmdArgs, cwd) {
  const result = spawnFn('git', cmdArgs, { cwd, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

/**
 * Execute the `wip(execute):` squash: `git reset --soft <forkPoint>` followed by
 * `git add -A`.
 *
 * `forkPoint` MUST be the value `detectWipSquash()` resolved — this function never
 * re-derives it. Passing a falsy fork-point is refused rather than guessed at: a
 * missing fork-point previously degraded to `git symbolic-ref --short HEAD`, which
 * made `git merge-base HEAD <that-branch>` a no-op and silently left the WIP
 * commits in history.
 *
 * @param {string|null} forkPoint  Commit-ish from detectWipSquash().forkPoint.
 * @param {{spawnFn?: Function, cwd?: string}} [opts]
 * @returns {{status: 'squashed', forkPoint: string}
 *          |{status: 'failed', forkPoint: string|null, message: string}}
 */
function runSquash(forkPoint, { spawnFn = spawnSync, cwd = process.cwd() } = {}) {
  if (!forkPoint || typeof forkPoint !== 'string' || forkPoint.trim().length === 0) {
    return {
      status: 'failed',
      forkPoint: forkPoint || null,
      message: 'No fork-point resolved by detectWipSquash() — refusing to soft-reset.',
    };
  }
  const resolved = forkPoint.trim();

  const reset = runGit(spawnFn, ['reset', '--soft', resolved], cwd);
  if (reset.status !== 0) {
    return {
      status: 'failed',
      forkPoint: resolved,
      message: reset.stderr || reset.stdout || 'git reset --soft failed',
    };
  }

  const add = runGit(spawnFn, ['add', '-A'], cwd);
  if (add.status !== 0) {
    return {
      status: 'failed',
      forkPoint: resolved,
      message: add.stderr || add.stdout || 'git add -A failed',
    };
  }

  return { status: 'squashed', forkPoint: resolved };
}

const STASH_MESSAGE = 'commit-sdlc: temp stash';

// ---------------------------------------------------------------------------
// Commit-failure classification (Task 3)
// ---------------------------------------------------------------------------

/**
 * Ordered signature table for classifying a failed `git commit`'s stderr/stdout.
 * Evaluated top-to-bottom in `classifyCommitFailure` — first match wins.
 *
 * Every entry here is `anchored: true` — wording specific to git's own
 * identity/gpg errors, GitHub's `remote:`-prefixed protected-branch
 * rejections (or `GH006`), and "nothing to commit" wording. None of this is
 * wording a pre-commit hook would plausibly print on its own, which is why
 * these signatures are allowed to override `hookPresent` — see
 * `classifyCommitFailure`. Looser wording (bare "user.email", bare
 * "protected branch") is deliberately NOT in this table: a hook could print
 * either for unrelated reasons, so it is left to fall through to the
 * `hookPresent`-driven classification instead.
 */
const FAILURE_SIGNATURES = [
  { re: /^\*\*\* Please tell me who you are|Author identity unknown|^fatal: (empty ident|unable to auto-detect email)/im, classification: 'identity', hookFailed: false, anchored: true },
  { re: /gpg failed to sign|signing failed|error: gpg/i, classification: 'gpg', hookFailed: false, anchored: true },
  { re: /nothing to commit|no changes added to commit|nothing added to commit but untracked files present/i, classification: 'nothing-to-commit', hookFailed: false, anchored: true },
  { re: /^remote: .*(protected branch|pre-receive hook declined)|GH006/im, classification: 'protected-branch', hookFailed: false, anchored: true },
];

/** Human-readable `reason` string per classification, for the failure JSON. */
const CLASSIFICATION_REASONS = {
  hook: 'pre-commit hook exited non-zero',
  identity: 'git commit failed — author identity is not configured',
  gpg: 'git commit failed — commit signing (gpg) failed',
  'nothing-to-commit': 'git commit failed — nothing to commit',
  'protected-branch': 'git commit failed — protected branch rejected the commit',
  ambiguous: 'pre-commit hook exited non-zero',
  other: 'git commit failed',
};

/**
 * Classify a failed `git commit`'s stderr/stdout into one of the taxonomy's
 * buckets. Pure function — no I/O.
 *
 * Only *anchored* signatures (git's own identity/gpg wording, `remote:`-
 * prefixed protected-branch rejections, nothing-to-commit) override
 * `hookPresent`. When a pre-commit hook is present and nothing anchored
 * matches, the failure is the hook's — even if its output happens to contain
 * words like "user.email" or "protected branch"; a false 'hook'
 * classification is safer than a false non-hook one, since the former keeps
 * stash-recovery guidance (see `runStashTransaction` below) while the latter
 * would suppress it. When no hook is present and nothing matches,
 * classification is 'other'. When hook presence is unknown, classification
 * is 'ambiguous'. `hookPresent` (from `detectPreCommitHook`, derived once
 * before the commit attempt) decides the no-match outcome:
 *   - `hookPresent === true`      -> classification 'hook', hookFailed: true
 *   - `hookPresent === false`     -> classification 'other', hookFailed: false
 *   - `hookPresent` undefined/null -> classification 'ambiguous', hookFailed: true
 *
 * @param {string} detail  commit stderr (fallback: stdout), trimmed.
 * @param {{hookPresent?: boolean|null}} [opts]
 * @returns {{hookFailed: boolean, classification: 'hook'|'identity'|'gpg'|
 *            'nothing-to-commit'|'protected-branch'|'ambiguous'|'other'}}
 */
function classifyCommitFailure(detail, { hookPresent } = {}) {
  const text = detail || '';
  for (const sig of FAILURE_SIGNATURES) {
    if (!sig.anchored && hookPresent !== false) continue;
    if (sig.re.test(text)) {
      return { hookFailed: sig.hookFailed, classification: sig.classification };
    }
  }
  if (hookPresent === false) return { hookFailed: false, classification: 'other' };
  if (hookPresent === true) return { hookFailed: true, classification: 'hook' };
  return { hookFailed: true, classification: 'ambiguous' };
}

/**
 * Detects whether a pre-commit hook is configured for the current repo.
 * Called at most ONCE per commit attempt — its result feeds directly into
 * `classifyCommitFailure` so the two never disagree about hook presence for
 * that attempt.
 *
 * Returns true if:
 *   - `core.hooksPath` is set (git config), OR
 *   - `<git-dir>/hooks/pre-commit` (resolved via
 *     `git rev-parse --git-path hooks/pre-commit`) exists and is executable, OR
 *   - `.husky/pre-commit` exists
 * else false.
 *
 * @param {{execFn: (args: string[]) => {status: number|null, stdout: string, stderr: string},
 *          fs?: typeof import('node:fs')}} opts
 * @returns {boolean}
 */
function detectPreCommitHook({ execFn, fs: fsMod = fs } = {}) {
  const hooksPathResult = execFn(['config', 'core.hooksPath']);
  const hooksPath = hooksPathResult && hooksPathResult.status === 0
    ? (hooksPathResult.stdout || '').trim()
    : '';
  if (hooksPath) return true;

  const gitPathResult = execFn(['rev-parse', '--git-path', 'hooks/pre-commit']);
  const preCommitPath = gitPathResult && gitPathResult.status === 0
    ? (gitPathResult.stdout || '').trim()
    : '';
  if (preCommitPath) {
    try {
      const stat = fsMod.statSync(preCommitPath);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return true;
    } catch (err) {
      // Not found or inaccessible — fall through to the husky check.
    }
  }

  try {
    const huskyStat = fsMod.statSync('.husky/pre-commit');
    if (huskyStat.isFile()) return true;
  } catch (err) {
    // Not found — no hook detected via any path.
  }

  return false;
}

/**
 * Wrap the commit in the stash transaction:
 *   git stash push --keep-index -m "commit-sdlc: temp stash"
 *   <commitFn>                    (git commit / git commit --amend)
 *   git stash pop
 *
 * The failure taxonomy is emitted HERE and nowhere else — commit-sdlc SKILL.md
 * Step 5 reads this shape, it never re-derives it:
 *
 *   {"committed": true,  "hookFailed": false, "popConflict": false}
 *   {"committed": false, "hookFailed": true,  "classification": "hook", "popConflict": false,
 *    "reason": "pre-commit hook exited non-zero"}
 *   {"committed": false, "hookFailed": false, "classification": "identity"|"gpg"|
 *    "nothing-to-commit"|"protected-branch"|"other", "popConflict": false,
 *    "reason": "<per-classification human string>"}
 *   {"committed": true,  "hookFailed": false, "popConflict": true,
 *    "conflictFiles": ["path/a.js"]}
 *
 * A `git stash push` failure aborts before any commit is attempted and returns
 * the same three flags with `committed: false` plus a `reason`.
 *
 * On hook failure (`hookFailed: true`, i.e. classification 'hook' or
 * 'ambiguous') the stash is deliberately LEFT in place (SKILL.md tells the
 * user to `git stash list`); popping it would discard the isolation the
 * transaction just established.
 *
 * On a commit failure, `detectPreCommitHook` is derived exactly once (not
 * re-checked per classification lookup) and fed straight into
 * `classifyCommitFailure`; the success path never needs it and never pays
 * for it.
 *
 * @param {Function} commitFn  () => {status, stdout, stderr} — runs the commit.
 * @param {{spawnFn?: Function, cwd?: string, noStash?: boolean, fs?: typeof import('node:fs')}} [opts]
 * @returns {{committed: boolean, hookFailed: boolean, classification?: string, popConflict: boolean,
 *            reason?: string, detail?: string, conflictFiles?: string[]}}
 */
function runStashTransaction(commitFn, { spawnFn = spawnSync, cwd = process.cwd(), noStash = false, fs: fsMod = fs } = {}) {
  let stashed = false;

  if (!noStash) {
    // `--keep-index` only stashes modified tracked files, so the same check
    // decides whether a stash is needed at all.
    const unstaged = runGit(spawnFn, ['diff', '--name-only'], cwd);
    const hasUnstaged = unstaged.status === 0 && unstaged.stdout.length > 0;

    if (hasUnstaged) {
      const push = runGit(spawnFn, ['stash', 'push', '--keep-index', '-m', STASH_MESSAGE], cwd);
      if (push.status !== 0) {
        return {
          committed: false,
          hookFailed: false,
          popConflict: false,
          reason: 'git stash push failed',
          detail: push.stderr || push.stdout || '',
        };
      }
      stashed = !/no local changes to save/i.test(push.stdout);
    }
  }

  const commit = commitFn();
  const commitStatus = commit && typeof commit.status === 'number' ? commit.status : 1;
  if (commitStatus !== 0) {
    // On hookFailed:true the stash is intentionally left in place — SKILL.md
    // instructs the user to recover it.
    const detail = ((commit && commit.stderr) || (commit && commit.stdout) || '').trim();

    // Derived ONCE, right here — classifyCommitFailure is the only consumer,
    // so hook presence is checked exactly once per failed commit rather than
    // being (re-)computed on every call or on the success path where it's
    // never used. `execFn`'s `--git-path` result and `fs`'s relative lookups
    // are both scoped to `cwd`, since `git rev-parse --git-path` prints a
    // path relative to the process cwd it ran in.
    let hookPresent;
    try {
      hookPresent = detectPreCommitHook({
        execFn: (args) => {
          const result = runGit(spawnFn, args, cwd);
          if (args[0] === 'rev-parse' && args.includes('--git-path') && result.status === 0 && result.stdout) {
            return { ...result, stdout: path.resolve(cwd, result.stdout) };
          }
          return result;
        },
        fs: {
          statSync: (p) => fsMod.statSync(path.isAbsolute(p) ? p : path.join(cwd, p)),
        },
      });
    } catch (err) {
      hookPresent = undefined; // detection failed — classifyCommitFailure treats this as ambiguous.
    }

    const { hookFailed, classification } = classifyCommitFailure(detail, { hookPresent });
    const out = {
      committed: false,
      hookFailed,
      classification,
      popConflict: false,
      reason: CLASSIFICATION_REASONS[classification],
    };
    if (detail) out.detail = detail;
    return out;
  }

  if (!stashed) {
    return { committed: true, hookFailed: false, popConflict: false };
  }

  const pop = runGit(spawnFn, ['stash', 'pop'], cwd);
  if (pop.status !== 0) {
    return {
      committed: true,
      hookFailed: false,
      popConflict: true,
      conflictFiles: collectConflictFiles(spawnFn, cwd, pop),
    };
  }

  return { committed: true, hookFailed: false, popConflict: false };
}

/**
 * Resolve the conflicted paths left behind by a failed `git stash pop`.
 * Prefers the unmerged index (`--diff-filter=U`); falls back to parsing the
 * `CONFLICT (...): Merge conflict in <path>` lines git printed.
 */
function collectConflictFiles(spawnFn, cwd, popResult) {
  const unmerged = runGit(spawnFn, ['diff', '--name-only', '--diff-filter=U'], cwd);
  if (unmerged.status === 0 && unmerged.stdout.length > 0) {
    return unmerged.stdout.split('\n').map(l => l.trim()).filter(Boolean);
  }

  const text = `${popResult.stdout}\n${popResult.stderr}`;
  const files = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^CONFLICT \([^)]*\): Merge conflict in (.+)$/);
    if (m) files.push(m[1].trim());
  }
  return files;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * `--squash-execute`: soft-reset to the fork-point detectWipSquash() resolved and
 * re-stage. `--fork-point <sha>` passes that value straight back from this script's
 * own detection output; when omitted the value is recomputed by calling
 * detectWipSquash() here. Either way the value comes from the single fork-point
 * resolver — never from a caller-constructed merge-base.
 */
function runSquashExecuteMode(cliForkPoint) {
  let forkPoint = cliForkPoint;
  if (!forkPoint) {
    try {
      forkPoint = detectWipSquash().forkPoint;
    } catch (err) {
      writeJsonLine(
        { status: 'failed', forkPoint: null, message: `Could not resolve fork-point: ${err.message}` },
        { exitCode: 1 },
      );
      return;
    }
  }
  const result = runSquash(forkPoint);
  writeJsonLine(result, { exitCode: result.status === 'failed' ? 1 : 0 });
}

/**
 * `--stash-transaction`: run stash → commit → stash-pop and emit the
 * {committed, hookFailed, popConflict} outcome.
 */
function runStashTransactionMode({ message, amend, noStash }) {
  if (!message) {
    writeJsonLine(
      {
        committed: false,
        hookFailed: false,
        popConflict: false,
        reason: '--stash-transaction requires --message <msg>',
      },
      { exitCode: 1 },
    );
    return;
  }

  const commitArgs = amend ? ['commit', '--amend', '-m', message] : ['commit', '-m', message];
  const commitFn = () => runGit(spawnSync, commitArgs, process.cwd());

  const result = runStashTransaction(commitFn, { noStash });
  writeJsonLine(result, { exitCode: result.committed ? 0 : 1 });
}

function main() {
  const parsed = parseArgs(process.argv);

  // Execution modes short-circuit the prepare pipeline: they perform git work and
  // emit one JSON line, rather than building the commit-context manifest.
  if (parsed.squashExecute) {
    runSquashExecuteMode(parsed.forkPoint);
    return;
  }
  if (parsed.stashTransaction) {
    runStashTransactionMode(parsed);
    return;
  }

  const projectRoot = resolveSdlcRoot(); // issue #351: route to main worktree .sdlc/
  const { noStash, scope, type, amend, auto, noSquashWip, expectedBranch, forceDefaultBranch, warnings: parseWarnings } = parsed;

  const errors   = [];
  const warnings = [...parseWarnings];

  // Issue #232: verifyAndMigrate gate (CLI > env > default false).
  const skipConfigCheck = resolveSkipConfigCheck(process.argv);
  const cv = ensureConfigVersion(projectRoot, { skip: skipConfigCheck, roles: ['project'] });
  if (cv.errors.length > 0) {
    for (const e of cv.errors) errors.push(`config-version: ${e.role}: ${e.message}`);
    writeOutput({ errors, warnings, flags: { skipConfigCheck }, migration: cv.migration }, 'commit-context', 1);
    return;
  }

  const flags = { noStash, scope, type, amend, auto, noSquashWip, skipConfigCheck, forceDefaultBranch };

  // Step 3: Validate git repo and get current branch
  let gitState;
  try {
    gitState = checkGitState(process.cwd());
  } catch (err) {
    errors.push(err.message);
    writeOutput({ errors, warnings }, 'commit-context', 1);
    return;
  }

  const { currentBranch } = gitState;

  // Default-branch detection (R14, fixes #398)
  const defaultBranch = resolveDefaultBranch();
  const onDefaultBranch = currentBranch === defaultBranch;

  // Branch-guard HARD GATE (R-expected-branch, issues #347, #348, #349)
  // Must run before any git commit invocation. Pure check — exits immediately on mismatch.
  const branchGuard = validateExpectedBranch(currentBranch, expectedBranch);
  if (branchGuard.active && !branchGuard.ok) {
    process.stderr.write(branchGuard.message + '\n');
    writeOutput({ errors: [branchGuard.message], warnings, currentBranch, branchGuard }, 'commit-context', 3);
    return;
  }

  // Step 3b: Read commit config
  let commitConfig = null;
  try {
    commitConfig = readSection(projectRoot, 'commit');
  } catch (err) {
    warnings.push(`Could not read commit config: ${err.message}`);
  }

  // Step 3c: Validate flags against config
  if (type && commitConfig?.allowedTypes && Array.isArray(commitConfig.allowedTypes) && commitConfig.allowedTypes.length > 0) {
    if (!commitConfig.allowedTypes.includes(type)) {
      errors.push(`Commit type "${type}" is not allowed. Allowed types: ${commitConfig.allowedTypes.join(', ')}`);
    }
  }

  if (scope && commitConfig?.allowedScopes && Array.isArray(commitConfig.allowedScopes) && commitConfig.allowedScopes.length > 0) {
    if (!commitConfig.allowedScopes.includes(scope)) {
      errors.push(`Commit scope "${scope}" is not allowed. Allowed scopes: ${commitConfig.allowedScopes.join(', ')}`);
    }
  }

  // Step 4: Get staged files
  const stagedRaw   = exec('git diff --cached --name-only', { cwd: process.cwd() });
  const stagedFiles = stagedRaw ? stagedRaw.split('\n').filter(Boolean) : [];

  // Detect wip(execute): commits since fork-point BEFORE the staged-files
  // gate (Fixes #392 / R35). When the user has only wip(execute): commits
  // and no staged changes on top, commit-sdlc SKILL.md Step 1c will
  // soft-reset to fork-point and re-stage — at that point the staged set
  // becomes non-empty. The prepare output therefore must surface
  // `wipSquash` even on the early "nothing staged" path so SKILL.md can
  // make the squash decision before erroring out to the user.
  let wipSquashEarly;
  try {
    wipSquashEarly = detectWipSquash();
  } catch (err) {
    warnings.push(`Could not detect wip(execute): commits for squash: ${err.message}`);
    wipSquashEarly = { commits: [], stagedClean: true, forkPoint: null };
  }

  // Step 5: Error if nothing staged and not amending
  if (stagedFiles.length === 0 && !amend) {
    // When there are wip(execute): commits to squash, the "nothing staged"
    // condition is resolvable via Step 1c soft-reset — surface wipSquash so
    // SKILL.md can detect this and proceed without surfacing the error.
    if (wipSquashEarly.commits.length === 0) {
      errors.push('No staged changes. Use `git add` to stage files before committing.');
    }
    writeOutput({ errors, warnings, currentBranch, flags, wipSquash: wipSquashEarly }, 'commit-context', errors.length > 0 ? 1 : 0);
    return;
  }

  // Step 5b: Warn when amending with no staged files
  if (stagedFiles.length === 0 && amend) {
    warnings.push('No staged changes. The amended commit will have the same file changes as the original.');
  }

  // Step 6: Get staged diff (may be empty when --amend with nothing staged)
  const stagedDiff = exec('git diff --cached', { cwd: process.cwd() }) || '';
  const { diff: finalDiff, diffTruncated, truncatedFiles } = truncateStagedDiff(stagedDiff);

  // Step 7: Get staged diff stat
  const stagedDiffStat = exec('git diff --cached --stat', { cwd: process.cwd() }) || '';

  // Step 8: Get unstaged files
  const unstagedRaw   = exec('git diff --name-only', { cwd: process.cwd() });
  const unstagedFiles = unstagedRaw ? unstagedRaw.split('\n').filter(Boolean) : [];

  // Step 9: Get untracked files
  const untrackedRaw   = exec('git ls-files --others --exclude-standard', { cwd: process.cwd() });
  const untrackedFiles = untrackedRaw ? untrackedRaw.split('\n').filter(Boolean) : [];

  // Step 10: Get recent commits (Task 3: restored to -15 to match
  // agents/commit-orchestrator.md "Last 15 commits" and skills/commit-sdlc/SKILL.md)
  const commitsRaw    = exec('git log --oneline -15', { cwd: process.cwd() });
  const recentCommits = commitsRaw ? commitsRaw.split('\n').filter(Boolean) : [];

  // Step 11: Get last commit message when amending
  let lastCommitMessage = null;
  if (amend) {
    const raw = exec('git log -1 --format=%B', { cwd: process.cwd() });
    lastCommitMessage = raw !== null ? raw.trim() : null;
  }

  // Step 12: Warn when amending on a protected branch
  if (amend && (currentBranch === 'main' || currentBranch === 'master')) {
    warnings.push(`You are on ${currentBranch}. Amending commits on a protected branch may cause issues.`);
  }

  // Default-branch guard (R14/C12, fixes #398)
  if (onDefaultBranch) {
    warnings.push(`Committing to default branch '${defaultBranch}' — this lands directly on the protected branch.`);
    if (auto && !forceDefaultBranch) {
      errors.push(`Refusing to --auto commit to default branch '${defaultBranch}'. Pass --force-default-branch to override, or remove --auto for interactive approval.`);
    }
  }

  // Step 13 (Fixes #392 / R35): wip(execute): squash detection — reuse the
  // result computed earlier (we always run detectWipSquash before the staged
  // gate so wipSquash is available even on the empty-staging path).
  const wipSquash = wipSquashEarly;

  const result = {
    errors,
    warnings,
    currentBranch,
    defaultBranch,
    onDefaultBranch,
    flags,
    migration: cv.migration,
    commitConfig,
    staged: {
      files:          stagedFiles,
      fileCount:      stagedFiles.length,
      diff:           finalDiff,
      diffStat:       stagedDiffStat,
      diffTruncated,
      truncatedFiles,
    },
    unstaged: {
      files:      unstagedFiles,
      fileCount:  unstagedFiles.length,
      hasChanges: unstagedFiles.length > 0,
    },
    untracked: {
      files:     untrackedFiles,
      fileCount: untrackedFiles.length,
    },
    recentCommits,
    lastCommitMessage,
    wipSquash,
    branchGuard,
  };

  const manifestPath = writeManifestState('commit', currentBranch, result);
  process.stdout.write(manifestPath + '\n');
  process.exit(result.errors && result.errors.length > 0 ? 1 : 0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`commit-prepare.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = {
  parseArgs, resolveDefaultBranch, detectWipSquash, runSquash, runStashTransaction,
  classifyCommitFailure, detectPreCommitHook,
};
