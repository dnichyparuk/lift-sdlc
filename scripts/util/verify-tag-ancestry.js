#!/usr/bin/env node
/**
 * verify-tag-ancestry.js — verify a git tag is an ancestor of a branch.
 *
 * Implements R-post-version-ancestry (issue #349).
 *
 * Usage:
 *   node verify-tag-ancestry.js --tag v1.2.3 --branch feat/x [--remote origin]
 *
 * Outputs JSON to stdout:
 *   { ok, tag, branch, branchRef, message }
 *
 * Exit codes:
 *   0 = tag IS an ancestor of branch (ok: true)
 *   1 = tag is NOT an ancestor, or an error occurred (ok: false)
 *
 * When --remote is provided (default "origin"), the check is performed against
 * <remote>/<branch> so it verifies the pushed state. When the remote ref does
 * not exist (e.g. --no-push mode), falls back to local <branch> ref and notes
 * the fallback in message.
 *
 * Routes through resolveSdlcRoot() (R-projectroot) so it works from sub-cwds
 * and linked worktrees.
 *
 * Zero npm dependencies — Node.js built-ins only.
 */
'use strict';

const path     = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');
const { resolveSdlcRoot } = require(path.join(LIB, 'config'));

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

const tag    = getArg('--tag');
const branch = getArg('--branch');
const remote = getArg('--remote') || 'origin';

if (!tag || !branch) {
  process.stderr.write('Usage: verify-tag-ancestry.js --tag <tag> --branch <branch> [--remote <remote>]\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, args_, cwd) {
  const result = spawnSync(cmd, args_, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}

function emit(ok, branchRef, message) {
  const output = { ok, tag, branch, branchRef, message: message || null };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const projectRoot = resolveSdlcRoot();

// Verify the tag exists
const tagCheck = run('git', ['rev-parse', '--verify', `refs/tags/${tag}`], projectRoot);
if (tagCheck.status !== 0) {
  const msg = `unknown tag: '${tag}' does not exist in this repository (refs/tags/${tag} not found). stderr: ${tagCheck.stderr}`;
  emit(false, null, msg);
}

// Try remote ref first (origin/branch)
const remoteBranchRef = `${remote}/${branch}`;
const remoteRefCheck  = run('git', ['rev-parse', '--verify', remoteBranchRef], projectRoot);

let branchRef;
let usingFallback = false;

if (remoteRefCheck.status === 0) {
  branchRef = remoteBranchRef;
} else {
  // Remote ref does not exist — fall back to local branch ref
  const localRefCheck = run('git', ['rev-parse', '--verify', `refs/heads/${branch}`], projectRoot);
  if (localRefCheck.status !== 0) {
    const msg = `unknown branch: neither '${remoteBranchRef}' nor local '${branch}' exist. Is the branch pushed? stderr: ${remoteRefCheck.stderr}`;
    emit(false, null, msg);
  }
  branchRef = branch;
  usingFallback = true;
}

// Check ancestry: is tag an ancestor of branchRef?
const ancestryCheck = run('git', ['merge-base', '--is-ancestor', tag, branchRef], projectRoot);

if (ancestryCheck.status === 0) {
  const note = usingFallback
    ? `Remote ref '${remoteBranchRef}' not found — checked local branch '${branch}' instead (fallback; branch may not be pushed yet).`
    : null;
  emit(true, branchRef, note);
} else {
  // Non-ancestor — check if this is a git error or a genuine non-ancestor result
  if (ancestryCheck.stderr && ancestryCheck.status > 1) {
    // git error (exit > 1)
    const msg = `git merge-base error for tag '${tag}' and ref '${branchRef}': ${ancestryCheck.stderr}`;
    emit(false, branchRef, msg);
  } else {
    // Normal non-ancestor (exit 1)
    const fallbackNote = usingFallback
      ? ` (checked local branch '${branch}' — remote ref '${remoteBranchRef}' not found)`
      : '';
    const msg = `Tag '${tag}' is not an ancestor of '${branchRef}'${fallbackNote}. The release commit landed on a different branch. Delete the tag (git push origin :refs/tags/${tag}; git tag -d ${tag}) and re-run version step on the correct branch.`;
    emit(false, branchRef, msg);
  }
}
