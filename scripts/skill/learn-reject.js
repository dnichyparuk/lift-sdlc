#!/usr/bin/env node
/**
 * learn-reject.js — closes the loop into the negative cache: given a PR
 * opened by `learn-apply.js --ship`, extracts the signatures it assimilated
 * and appends them to `config.rejected_guardrails` on the *default* branch —
 * so every future `learn-prepare.js` run (on this machine or any other
 * clone) refuses to re-propose the same signature.
 *
 * BRANCH HANDLING — throwaway branch, never the developer's local default
 * branch (iteration-3/4/5 fixes; see the task's Notes for the full history)
 * ---------------------------------------------------------------------------
 * The negative cache must land where `learn-prepare.js` actually reads it:
 * `origin/<defaultBranch>` (never a local branch — see learn-prepare.js's
 * `capturePreImage`). Checking out the developer's *local* default branch and
 * committing there is unsafe: their local branch can be behind
 * `origin/<defaultBranch>`, so a plain `git push` could be silently rejected
 * as non-fast-forward. Fix: build a throwaway branch straight off the freshly
 * fetched `origin/<defaultBranch>` (mirrors learn-prepare.js's assimilation
 * branch exactly), mutate `.sdlc/config.json` there, commit, and
 * `git push origin HEAD:<defaultBranch>` — a direct push onto the default
 * branch ref, no PR, mirroring the ADR's original "commit and push" language
 * for rejection.
 *
 * Concrete sequence (order is load-bearing):
 *   (1) capture `initialBranch`
 *   (2) fetch the PR body (`gh pr view`) and extract signatures — read-only,
 *       fails fast on a bad `--pr` before any git mutation
 *   (3) `git fetch origin <defaultBranch>`
 *   (4) clean-tree precondition — identical two-part check to
 *       learn-prepare.js's `checkCleanTree`/`hasUntrackedConfig`
 *   (5) `createBranch(root, 'sdlc/reject-<ts>', 'origin/<defaultBranch>')`
 *   (6) classify whether `.sdlc/config.json` exists at that ref
 *       (`git ls-tree` first — mirrors learn-prepare.js's `capturePreImage`)
 *   (7) create-or-modify the file, staging **only** `.sdlc/config.json` by
 *       exact path (never `-A`/`--all`/`.` — this branch is pushed straight
 *       to the default branch with no PR review gate)
 *   (8) commit, then `git push origin HEAD:<defaultBranch>`
 *   (9) **only on a successful push**: delete each matching pending file and
 *       run `gh pr close` — deletion must never happen before the push
 *       succeeds, or a push race would destroy the changesets while the
 *       negative cache never actually lands
 *
 * A rejected push (a genuine race) exits 1 with a message to re-run rather
 * than an automatic retry — an accepted v1 limitation, consistent with how
 * concurrent-assimilation races are handled elsewhere in this plan — and
 * leaves the pending files untouched.
 *
 * ROLLBACK / RETURN — every exit path, not only success
 * ---------------------------------------------------------------------------
 * If the run fails after `.sdlc/config.json` was touched on the throwaway
 * branch but before it was committed, that edit is restored by the same
 * `preImageStatus`-branched command Task 6 (`learn-apply.js`) uses for its
 * own rollback: `'absent'` -> `fs.unlinkSync` (a `git checkout --` fails on
 * an untracked path with a pathspec error and would leave the stray file in
 * place, tripping learn-prepare.js's own untracked-config abort on the
 * developer's next run); `'resolved'` -> `git checkout -- .sdlc/config.json`
 * (`checkoutBranch` does **not** report `'dirty'` for an uncommitted edit —
 * its dirty check only fires when the file's *committed* content actually
 * differs between branches, which an uncommitted edit never guarantees).
 * After either restore, `git status --porcelain -- .sdlc/config.json` must
 * come back empty (a `??` line counts as non-empty) before proceeding.
 *
 * Whatever the outcome, the script always returns to `initialBranch` before
 * exiting, then deletes the throwaway branch with `git branch -D` (not `-d`
 * — cleanup also runs on paths where the branch is genuinely unmerged
 * relative to `initialBranch`) as best-effort, non-fatal cleanup — never
 * while it is still checked out.
 *
 * KD8 — per-script constants stay local; no shared constants module.
 * KD9 — pre-tool-git-guard.js does NOT backstop this script (it inspects
 *       only top-level run_command text and never a Node script's internal
 *       spawnSync calls). Safety is local: no --force anywhere, exact-path
 *       staging only, explicit initialBranch recorded for rollback.
 *
 * Exit codes
 *   0  signature(s) pushed directly onto defaultBranch via a throwaway
 *      branch, pending files deleted, PR closed, throwaway branch removed,
 *      back on initialBranch
 *   1  invalid input, gh failure, or a non-fast-forward push race (config
 *      and pending files untouched in the race case, re-run to retry;
 *      always still returns to initialBranch)
 *   2  crash, or an automated rollback/return-to-branch step itself failed
 *      to verify clean — still attempts to restore any uncommitted edit,
 *      return to initialBranch, and best-effort delete the throwaway branch
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');
const { resolveSdlcRoot } = require(path.join(LIB, 'config'));
const { createBranch, checkoutBranch, detectBaseBranchSafe } = require(path.join(LIB, 'git'));
const { parsePendingFile, SIGNATURE_PATTERN } = require(path.join(LIB, 'learnings'));
const { checkCleanTree: sharedCheckCleanTree, hasUntrackedConfig: sharedHasUntrackedConfig } =
  require(path.join(LIB, 'clean-tree'));

// KD8 — local constants. Git always reports POSIX-separated paths, so the
// pending-directory prefix is a literal string, never path.join output.
const PENDING_DIR     = '.sdlc/learnings/pending';
const PENDING_PREFIX  = '.sdlc/learnings/pending/';
const CONFIG_PATH     = '.sdlc/config.json';
const BRANCH_PREFIX   = 'sdlc/reject-';
const MANUAL_RECOVERY = 'MANUAL RECOVERY REQUIRED';

// ---------------------------------------------------------------------------
// CLI parsing — mirrors harden-prepare.js / learn-prepare.js posture
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    let key, val;
    if (eq !== -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      val = argv[i + 1];
      if (val !== undefined && !val.startsWith('--')) {
        i++;
      } else {
        val = '';
      }
    }
    out[key] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// git helper — spawnSync with argv arrays, never a shell string
// ---------------------------------------------------------------------------

function git(projectRoot, args) {
  return spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
}

function stderrOf(result) {
  if (!result) return '(no result)';
  if (result.error) return result.error.message;
  return result.stderr ? result.stderr.trim() : `exit ${result.status}`;
}

// ---------------------------------------------------------------------------
// PR-body signature extraction (Contract "shape (docs)")
// ---------------------------------------------------------------------------

/**
 * Extract the FIRST `## Assimilated signatures` block Task 6's
 * `renderPrBody` emits: find the first line-start match of the heading, read
 * lines until the next `## ` heading (or end of body), extract each
 * backticked token immediately after `- `, ignore the ` — impact: ...`
 * suffix, and re-validate each token against SIGNATURE_PATTERN. This
 * specifically defends against the review-only assessment section
 * (untrusted LLM output, rendered further down in the same PR body)
 * containing a look-alike heading: the block ends at the NEXT `## `
 * heading, which is the genuine `## Regression check`, so a forged heading
 * buried inside the fenced assessment text below is never reached.
 *
 * @param {string} body
 * @returns {{valid: string[], dropped: string[]}}
 */
function extractSignatures(body) {
  const text = typeof body === 'string' ? body : '';
  const startMatch = /^## Assimilated signatures\s*$/m.exec(text);
  if (!startMatch) return { valid: [], dropped: [] };

  const afterStart = startMatch.index + startMatch[0].length;
  const rest = text.slice(afterStart);
  const nextHeading = /^## /m.exec(rest);
  const block = nextHeading ? rest.slice(0, nextHeading.index) : rest;

  const collected = [];
  for (const line of block.split('\n')) {
    const m = line.match(/^- `([^`]+)`/);
    if (m) collected.push(m[1]);
  }

  const valid = [];
  const dropped = [];
  for (const sig of collected) {
    if (SIGNATURE_PATTERN.test(sig)) valid.push(sig);
    else dropped.push(sig);
  }
  return { valid, dropped };
}

/** Merge additions into an existing flat array, deduplicated, order-stable. */
function mergeRejected(existing, additions) {
  const seen = new Set();
  const result = [];
  for (const s of Array.isArray(existing) ? existing : []) {
    if (typeof s === 'string' && s.trim() !== '' && !seen.has(s)) {
      seen.add(s);
      result.push(s);
    }
  }
  for (const s of additions) {
    if (!seen.has(s)) {
      seen.add(s);
      result.push(s);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Clean-tree precondition — identical two-part check to learn-prepare.js
// ---------------------------------------------------------------------------

// dequote/checkCleanTree/hasUntrackedConfig live in lib/clean-tree.js — shared
// verbatim with learn-prepare.js (code-quality-review finding: these three
// were previously copy-pasted across both scripts and had already drifted).

function checkCleanTree(projectRoot) {
  return sharedCheckCleanTree(projectRoot, {
    pendingDir: PENDING_DIR,
    pendingPrefix: PENDING_PREFIX,
    actionVerb: 'rejecting',
  });
}

/** `.sdlc/config.json` must only ever originate from tracked history — mirrors learn-prepare.js. */
function hasUntrackedConfig(projectRoot) {
  return sharedHasUntrackedConfig(projectRoot, CONFIG_PATH);
}

// ---------------------------------------------------------------------------
// preImageStatus classification — mirrors learn-prepare.js's capturePreImage
// ---------------------------------------------------------------------------

/**
 * Classify via `git ls-tree` FIRST, same rationale as learn-prepare.js: the
 * exit code alone cannot separate "path absent at this ref" from "bad ref"
 * (both are 128 from `git show`).
 *
 * @returns {{status:'resolved'|'absent'|'error', config:object|null, error:string|null}}
 */
function classifyConfig(projectRoot, defaultBranch) {
  const ref = `origin/${defaultBranch}`;

  const lsTree = git(projectRoot, ['ls-tree', '--name-only', ref, '--', CONFIG_PATH]);
  if (lsTree.status !== 0) {
    return { status: 'error', config: null, error: `cannot resolve ${ref} to classify the ${CONFIG_PATH} pre-image: ${stderrOf(lsTree)}` };
  }
  if (!(lsTree.stdout || '').trim()) {
    return { status: 'absent', config: null, error: null };
  }

  const show = git(projectRoot, ['show', `${ref}:${CONFIG_PATH}`]);
  if (show.status !== 0) {
    return { status: 'error', config: null, error: `cannot read ${ref}:${CONFIG_PATH} (present per ls-tree): ${stderrOf(show)}` };
  }
  let config;
  try {
    config = JSON.parse(show.stdout);
  } catch (err) {
    return { status: 'error', config: null, error: `${ref}:${CONFIG_PATH} is not valid JSON — ${err.message}` };
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { status: 'error', config: null, error: `${ref}:${CONFIG_PATH} did not parse to a JSON object` };
  }
  return { status: 'resolved', config, error: null };
}

// ---------------------------------------------------------------------------
// Restore — literal preImageStatus-branched commands, mirrors learn-apply.js
// ---------------------------------------------------------------------------

function restoreConfig(projectRoot, preImageStatus) {
  const abs = path.resolve(projectRoot, CONFIG_PATH);
  const scope = path.resolve(projectRoot, '.sdlc') + path.sep;
  if (!abs.startsWith(scope)) {
    return { ok: false, action: 'refused', reason: `refusing to touch ${abs} — it resolves outside ${scope}` };
  }

  if (preImageStatus === 'absent') {
    // Untracked on the throwaway branch — `git checkout --` fails with a
    // pathspec error and leaves it in place. Unlink it instead.
    try {
      fs.unlinkSync(abs);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return { ok: false, action: 'unlink', reason: `could not delete ${CONFIG_PATH}: ${err.message}` };
      }
    }
    if (fs.existsSync(abs)) {
      return { ok: false, action: 'unlink', reason: `${CONFIG_PATH} still exists after unlink` };
    }
    return { ok: true, action: 'unlinked' };
  }

  // Unstage first. `git checkout --` restores the working tree from the INDEX,
  // so if staging already succeeded and only the commit failed, checking out
  // alone would re-write the staged (new) content back and leave the file
  // dirty — pushing a genuinely restorable state into MANUAL RECOVERY. An
  // unstage is a no-op when nothing is staged, so this is safe on every path.
  git(projectRoot, ['reset', '--quiet', '--', CONFIG_PATH]);

  const result = git(projectRoot, ['checkout', '--', CONFIG_PATH]);
  if (result.status !== 0) {
    return { ok: false, action: 'checkout', reason: `git checkout -- ${CONFIG_PATH} failed: ${stderrOf(result)}` };
  }
  return { ok: true, action: 'checked-out' };
}

function verifyConfigClean(projectRoot) {
  const status = git(projectRoot, ['status', '--porcelain', '--', CONFIG_PATH]);
  return status.status === 0 && (status.stdout || '') === '';
}

// ---------------------------------------------------------------------------
// Pending-file disposition — post-push, path-scoped, tolerant of absence
// ---------------------------------------------------------------------------

/**
 * Deletes each pending file whose parsed signature matches an extracted
 * signature. Plain filesystem delete, path-scoped to
 * `.sdlc/learnings/pending/`, never a git operation (pending files stay
 * untracked throughout). This is a defensive, largely redundant step: the
 * normal assimilation path (learn-apply --ship) already deleted these same
 * files after its PR opened. It only matters if new pending files carrying
 * the same signature were written after that. ENOENT is a silent no-op.
 */
function deleteMatchingPendingFiles(projectRoot, signatures) {
  const sigSet = new Set(signatures);
  const dir = path.join(projectRoot, PENDING_DIR);
  const deleted = [];
  const warnings = [];

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { deleted, warnings };
    warnings.push(`cannot read ${PENDING_DIR}: ${err.message}`);
    return { deleted, warnings };
  }

  for (const name of names.filter(n => n.endsWith('.md')).sort()) {
    const relPath = `${PENDING_PREFIX}${name}`;
    const abs = path.join(dir, name);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      warnings.push(`cannot read ${relPath}: ${err.message}`);
      continue;
    }
    const parsed = parsePendingFile(content, relPath);
    if (!parsed.valid || !sigSet.has(parsed.signature)) continue;
    try {
      fs.unlinkSync(abs);
      deleted.push(relPath);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      warnings.push(`could not delete ${relPath}: ${err.message}`);
    }
  }

  return { deleted, warnings };
}

// ---------------------------------------------------------------------------
// Branch cleanup — never delete while checked out
// ---------------------------------------------------------------------------

function bestEffortDeleteBranch(projectRoot, branchName) {
  if (!branchName) return;
  const current = git(projectRoot, ['branch', '--show-current']);
  if ((current.stdout || '').trim() === branchName) return;
  spawnSync('git', ['branch', '-D', branchName], { cwd: projectRoot, encoding: 'utf8' });
}

/**
 * Restore (if needed) -> verify -> checkoutBranch(initialBranch) -> verify ->
 * best-effort delete the throwaway branch, then exit. Every exit path from
 * `runReject` after a branch was created funnels through this.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.initialBranch
 * @param {string} opts.branchName
 * @param {'absent'|'resolved'|null} opts.preImageStatus — null skips restore
 *   (nothing was written yet, or the write was already committed).
 * @param {number} opts.exitCode — used only if every step below succeeds.
 */
function cleanupAndExit({ projectRoot, initialBranch, branchName, preImageStatus, exitCode }) {
  if (preImageStatus === 'absent' || preImageStatus === 'resolved') {
    const restore = restoreConfig(projectRoot, preImageStatus);
    if (!restore.ok) {
      process.stderr.write(`learn-reject: ${MANUAL_RECOVERY} — could not restore ${CONFIG_PATH} (${restore.action}): ${restore.reason}\n`);
      try { checkoutBranch(projectRoot, initialBranch); } catch (_) { /* best-effort */ }
      bestEffortDeleteBranch(projectRoot, branchName);
      process.exit(2);
      return;
    }
    if (!verifyConfigClean(projectRoot)) {
      process.stderr.write(`learn-reject: ${MANUAL_RECOVERY} — git status --porcelain -- ${CONFIG_PATH} is not empty after restore (${restore.action})\n`);
      try { checkoutBranch(projectRoot, initialBranch); } catch (_) { /* best-effort */ }
      bestEffortDeleteBranch(projectRoot, branchName);
      process.exit(2);
      return;
    }
  }

  const checkout = checkoutBranch(projectRoot, initialBranch);
  if (checkout.status !== 'checked-out') {
    const detail = checkout.stderr ? `: ${checkout.stderr}` : '';
    process.stderr.write(`learn-reject: ${MANUAL_RECOVERY} — checkoutBranch(${initialBranch}) returned '${checkout.status}'${detail}\n`);
    bestEffortDeleteBranch(projectRoot, branchName);
    process.exit(2);
    return;
  }

  bestEffortDeleteBranch(projectRoot, branchName);
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Crash cleanup — best-effort, never throws, used by main()'s outer catch
// ---------------------------------------------------------------------------

function crashCleanup(state) {
  try {
    if (!state.branchName) return;
    if (!state.committed && (state.preImageStatus === 'absent' || state.preImageStatus === 'resolved')) {
      try { restoreConfig(state.projectRoot, state.preImageStatus); } catch (_) { /* best-effort */ }
    }
    if (state.initialBranch) {
      try { checkoutBranch(state.projectRoot, state.initialBranch); } catch (_) { /* best-effort */ }
    }
    bestEffortDeleteBranch(state.projectRoot, state.branchName);
  } catch (_) {
    // never throw from crash cleanup
  }
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

function runReject({ projectRoot, prNumber, initialBranch, state }) {
  // Read-only first: fetch the PR body and extract signatures before any
  // git mutation, so a bad --pr or an empty signature block fails fast.
  const prView = spawnSync('gh', ['pr', 'view', prNumber, '--json', 'body'], { cwd: projectRoot, encoding: 'utf8' });
  if (prView.status !== 0) {
    process.stderr.write(`learn-reject: gh pr view ${prNumber} failed: ${(prView.stderr || prView.stdout || `exit ${prView.status}`).trim()}\n`);
    process.exit(1);
    return;
  }
  let prJson;
  try {
    prJson = JSON.parse(prView.stdout);
  } catch (err) {
    process.stderr.write(`learn-reject: gh pr view ${prNumber} returned invalid JSON — ${err.message}\n`);
    process.exit(1);
    return;
  }
  const body = typeof (prJson && prJson.body) === 'string' ? prJson.body : '';

  const { valid: signatures, dropped } = extractSignatures(body);
  for (const bad of dropped) {
    process.stderr.write(`learn-reject: dropping token "${bad}" from PR #${prNumber} — failed re-validation against SIGNATURE_PATTERN\n`);
  }
  if (signatures.length === 0) {
    process.stderr.write(`learn-reject: no valid signature found in PR #${prNumber}'s "## Assimilated signatures" block — nothing to reject\n`);
    process.exit(1);
    return;
  }

  const defaultBranch = detectBaseBranchSafe(projectRoot);

  const fetched = git(projectRoot, ['fetch', 'origin', defaultBranch]);
  if (fetched.status !== 0) {
    process.stderr.write(`learn-reject: git fetch origin ${defaultBranch} failed — refusing to read a stale origin/${defaultBranch}: ${stderrOf(fetched)}\n`);
    process.exit(1);
    return;
  }

  const problems = checkCleanTree(projectRoot);
  if (hasUntrackedConfig(projectRoot)) {
    problems.push(`${CONFIG_PATH} exists as an UNTRACKED file — it must come only from origin/${defaultBranch}'s tracked history. Remove or commit the stray copy before rejecting learnings.`);
  }
  if (problems.length > 0) {
    process.stderr.write(`learn-reject: ${problems.join('\n')}\n`);
    process.exit(1);
    return;
  }

  const branchName = `${BRANCH_PREFIX}${Date.now()}`;
  const created = createBranch(projectRoot, branchName, `origin/${defaultBranch}`);
  if (created.status !== 'created') {
    const detail = created.stderr ? `: ${created.stderr}` : '';
    process.stderr.write(`learn-reject: createBranch failed for ${branchName} from origin/${defaultBranch}${detail}\n`);
    process.exit(1);
    return;
  }
  state.branchName = branchName;

  const classified = classifyConfig(projectRoot, defaultBranch);
  state.preImageStatus = classified.status;
  if (classified.status === 'error') {
    process.stderr.write(`learn-reject: ${classified.error}\n`);
    cleanupAndExit({ projectRoot, initialBranch, branchName, preImageStatus: null, exitCode: 1 });
    return;
  }

  const nextConfig = classified.status === 'absent'
    ? { rejected_guardrails: mergeRejected([], signatures) }
    : { ...classified.config, rejected_guardrails: mergeRejected(classified.config.rejected_guardrails, signatures) };

  const absConfigPath = path.resolve(projectRoot, CONFIG_PATH);
  try {
    fs.mkdirSync(path.dirname(absConfigPath), { recursive: true });
    fs.writeFileSync(absConfigPath, JSON.stringify(nextConfig, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`learn-reject: could not write ${CONFIG_PATH}: ${err.message}\n`);
    cleanupAndExit({ projectRoot, initialBranch, branchName, preImageStatus: classified.status, exitCode: 1 });
    return;
  }

  // Exact path only — never -A, --all, or `.`.
  const add = git(projectRoot, ['add', '--', CONFIG_PATH]);
  if (add.status !== 0) {
    process.stderr.write(`learn-reject: git add -- ${CONFIG_PATH} failed: ${stderrOf(add)}\n`);
    cleanupAndExit({ projectRoot, initialBranch, branchName, preImageStatus: classified.status, exitCode: 1 });
    return;
  }

  const commitMsg = signatures.length === 1
    ? `chore(sdlc): reject learning signature ${signatures[0]}`
    : `chore(sdlc): reject ${signatures.length} learning signatures`;
  const commit = git(projectRoot, ['commit', '-m', commitMsg]);
  if (commit.status !== 0) {
    process.stderr.write(`learn-reject: git commit failed: ${stderrOf(commit)}\n`);
    cleanupAndExit({ projectRoot, initialBranch, branchName, preImageStatus: classified.status, exitCode: 1 });
    return;
  }
  state.committed = true;

  // Direct push onto the default branch — no PR, no review gate.
  const push = git(projectRoot, ['push', 'origin', `HEAD:${defaultBranch}`]);
  if (push.status !== 0) {
    process.stderr.write(
      `learn-reject: git push origin HEAD:${defaultBranch} failed (likely a non-fast-forward race) — re-run learn-reject.js to retry. ` +
      `${CONFIG_PATH} on origin/${defaultBranch} and pending changesets were left untouched: ${stderrOf(push)}\n`
    );
    // Already committed on the throwaway branch — nothing uncommitted to restore.
    cleanupAndExit({ projectRoot, initialBranch, branchName, preImageStatus: null, exitCode: 1 });
    return;
  }

  // Only on a successful push: delete matching pending files, then close the PR.
  const { deleted, warnings } = deleteMatchingPendingFiles(projectRoot, signatures);
  for (const w of warnings) process.stderr.write(`learn-reject: ${w}\n`);
  if (deleted.length > 0) {
    process.stderr.write(`learn-reject: deleted pending changeset(s): ${deleted.join(', ')}\n`);
  }

  const closed = spawnSync('gh', ['pr', 'close', prNumber], { cwd: projectRoot, encoding: 'utf8' });
  if (closed.status !== 0) {
    process.stderr.write(
      `learn-reject: signature(s) ${signatures.join(', ')} were pushed to origin/${defaultBranch}, but gh pr close ${prNumber} failed — close it manually: ${(closed.stderr || closed.stdout || `exit ${closed.status}`).trim()}\n`
    );
    cleanupAndExit({ projectRoot, initialBranch, branchName, preImageStatus: null, exitCode: 1 });
    return;
  }

  process.stderr.write(`learn-reject: rejected signature(s) ${signatures.join(', ')} — pushed to origin/${defaultBranch}, PR #${prNumber} closed.\n`);
  cleanupAndExit({ projectRoot, initialBranch, branchName, preImageStatus: null, exitCode: 0 });
}

function main() {
  const cli = parseArgs(process.argv.slice(2));
  const projectRoot = resolveSdlcRoot();

  const prRaw = cli.pr !== undefined ? String(cli.pr).trim() : '';
  if (!/^\d+$/.test(prRaw)) {
    process.stderr.write(`learn-reject: --pr must be a positive integer (got: "${cli.pr === undefined ? '' : cli.pr}")\n`);
    process.exit(1);
    return;
  }

  const branchResult = git(projectRoot, ['branch', '--show-current']);
  const initialBranch = (branchResult.stdout || '').trim();
  if (branchResult.status !== 0 || !initialBranch) {
    process.stderr.write(`learn-reject: cannot determine the current branch: ${stderrOf(branchResult)}\n`);
    process.exit(1);
    return;
  }

  const state = { projectRoot, initialBranch, branchName: null, preImageStatus: null, committed: false };

  try {
    runReject({ projectRoot, prNumber: prRaw, initialBranch, state });
  } catch (err) {
    crashCleanup(state);
    process.stderr.write(`learn-reject.js crashed: ${err.stack || err.message}\n`);
    process.exit(2);
  }
}

module.exports = {
  parseArgs,
  extractSignatures,
  mergeRejected,
  checkCleanTree,
  hasUntrackedConfig,
  classifyConfig,
  restoreConfig,
  verifyConfigClean,
  deleteMatchingPendingFiles,
  bestEffortDeleteBranch,
  cleanupAndExit,
  crashCleanup,
  runReject,
  main,
  CONFIG_PATH,
  PENDING_DIR,
  PENDING_PREFIX,
  BRANCH_PREFIX,
  MANUAL_RECOVERY,
};

if (require.main === module) {
  main();
}
