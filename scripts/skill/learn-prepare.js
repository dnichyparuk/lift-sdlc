#!/usr/bin/env node
/**
 * learn-prepare.js — pre-computes the manifest for the self-learning
 * assimilation run: which pending learnings changesets are eligible, the
 * assimilation branch to apply them on, and the `.sdlc/config.json` pre-image
 * the strengthen-only regression gate (ci/validate-guardrail-regression.js)
 * later diffs against.
 *
 * The pre-image is snapshotted HERE, not re-read at apply time, so the
 * prepare-to-validate TOCTOU window is closed. `initialBranch` is captured
 * before any checkout so the apply/abort path can restore it.
 *
 * Step order (R8 — fixed, do not reorder):
 *   (1) `git fetch origin <defaultBranch>`  — so nothing below reads a stale
 *       remote-tracking ref
 *   (2) clean-tree precondition — exactly two checks: tracked-file
 *       modifications, and untracked entries outside
 *       `.sdlc/learnings/pending/` (an untracked `.sdlc/config.json` is
 *       called out separately: that file must only ever originate from
 *       origin/<defaultBranch>'s tracked history)
 *   (3) pre-image capture + preImageStatus classification via
 *       `git ls-tree` FIRST (exit code alone cannot separate "path absent"
 *       from "bad ref" — both are 128), then `git show` only when the path
 *       exists
 *   (0) eligibility filtering — interleaved here because it consumes
 *       preImage.rejected_guardrails from step 3
 *   (4) createBranch — never reached when step 3 classified 'error'
 *
 * Pending files stay UNTRACKED. This script never stages, commits, or deletes
 * them; disposition happens in learn-apply.js --ship after a run succeeds.
 *
 * The rejected-signature list comes from the origin/<defaultBranch> pre-image,
 * NOT from a local `readSection(root, 'rejected_guardrails')` read: rejections
 * are written straight to the default branch, so a developer's local branch
 * would not reflect a just-rejected signature until they pulled (R5).
 *
 * Short-circuit (R7, explicitly optional): when `.sdlc/learnings/pending/`
 * holds no parseable changeset at all there is nothing this run could ever
 * assimilate, so steps 1-4 are skipped entirely — no network call, no
 * clean-tree scan, no branch. The manifest then reports
 * `preImageStatus: 'error'` with an empty `preImage`, because no pre-image was
 * captured; that is the fail-closed value, so any downstream that ignores the
 * empty `eligible[]` still refuses to apply.
 *
 * KD4 — createBranch comes from lib/git.js; no new git primitives here.
 * KD8 — per-script constants stay local; no shared constants module.
 * KD9 — pre-tool-git-guard.js does NOT backstop this script (it inspects only
 *       top-level run_command text and excludes `checkout` from its mutation
 *       regex). Safety is local: no --force anywhere, explicit initialBranch
 *       recorded for rollback.
 *
 * Exit codes: 0 success, 1 validation/fatal (errors[] in the manifest),
 *             2 crash (stderr only).
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');
const { writeOutput } = require(path.join(LIB, 'output'));
const { resolveSdlcRoot, readSection } = require(path.join(LIB, 'config'));
const { createBranch, detectBaseBranchSafe } = require(path.join(LIB, 'git'));
const {
  parsePendingFile,
  filterRejected,
  groupBySignature,
  selectEligible,
} = require(path.join(LIB, 'learnings'));

// KD8 — local constants. Git always reports POSIX-separated paths, so the
// pending-directory prefix is a literal string, never path.join output.
const PENDING_DIR       = '.sdlc/learnings/pending';
const PENDING_PREFIX    = '.sdlc/learnings/pending/';
const CONFIG_PATH       = '.sdlc/config.json';
const DEFAULT_THRESHOLD = 3;
const BRANCH_PREFIX     = 'sdlc/assimilation-';

// ---------------------------------------------------------------------------
// CLI parsing — mirrors harden-prepare.js posture
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (a === '--output-file') continue; // handled by writeOutput
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

function camelKey(k) {
  return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {};
    const buf = fs.readFileSync(0, 'utf8');
    if (!buf.trim()) return {};
    return JSON.parse(buf);
  } catch (err) {
    process.stderr.write(`learn-prepare: stdin JSON parse failed — ${err.message}\n`);
    return {};
  }
}

function safeExec(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch (err) {
    process.stderr.write(`learn-prepare: git command failed (${cmd.split(' ')[0]}): ${err.stderr ? err.stderr.toString().trim() : err.message}\n`);
    return '';
  }
}

function git(projectRoot, args) {
  return spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
}

function stderrOf(result) {
  if (result.error) return result.error.message;
  return result.stderr ? result.stderr.trim() : `exit ${result.status}`;
}

// ---------------------------------------------------------------------------
// Pending changesets — read + parse only. Filtering happens after the
// pre-image resolves (R8 step 0).
// ---------------------------------------------------------------------------

function readPendingChangesets(projectRoot) {
  const dir = path.join(projectRoot, PENDING_DIR);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { parsed: [], skipped: [], fatal: null };
    return { parsed: [], skipped: [], fatal: `cannot read ${PENDING_DIR}: ${err.message}` };
  }

  const parsed = [];
  const skipped = [];
  for (const name of names.filter(n => n.endsWith('.md')).sort()) {
    const relPath = `${PENDING_PREFIX}${name}`;
    let content;
    try {
      content = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (err) {
      skipped.push({ filePath: relPath, reason: `cannot read file: ${err.message}` });
      continue;
    }
    const result = parsePendingFile(content, relPath);
    if (result.valid) {
      parsed.push(result);
    } else {
      // R4 — malformed changesets are excluded but always logged.
      skipped.push({ filePath: relPath, reason: result.reason });
    }
  }

  return { parsed, skipped, fatal: null };
}

// ---------------------------------------------------------------------------
// R8 step 2 — clean-tree precondition (exactly two checks)
// ---------------------------------------------------------------------------

/** Strip git's C-style quoting from a porcelain path when present. */
function dequote(p) {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p);
    } catch (_) {
      return p.slice(1, -1);
    }
  }
  return p;
}

function checkCleanTree(projectRoot) {
  const problems = [];

  // (a) tracked-file modifications
  const tracked = git(projectRoot, ['status', '--porcelain', '--untracked-files=no']);
  if (tracked.status !== 0) {
    problems.push(`clean-tree check failed: git status --untracked-files=no: ${stderrOf(tracked)}`);
    return problems;
  }
  const trackedPaths = (tracked.stdout || '')
    .split('\n')
    .filter(Boolean)
    .map(line => dequote(line.slice(3).trim()));
  if (trackedPaths.length > 0) {
    problems.push(`working tree is dirty — tracked files with uncommitted changes: ${trackedPaths.join(', ')}. Commit or stash them before assimilating learnings.`);
  }

  // (b) untracked entries other than .sdlc/learnings/pending/**
  const all = git(projectRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (all.status !== 0) {
    problems.push(`clean-tree check failed: git status --untracked-files=all: ${stderrOf(all)}`);
    return problems;
  }
  const strayUntracked = (all.stdout || '')
    .split('\n')
    .filter(line => line.startsWith('??'))
    .map(line => dequote(line.slice(3).trim()))
    .filter(p => p && !p.startsWith(PENDING_PREFIX));
  if (strayUntracked.length > 0) {
    problems.push(`working tree is dirty — untracked entries outside ${PENDING_DIR}/: ${strayUntracked.join(', ')}. Remove or commit them before assimilating learnings.`);
  }

  return problems;
}

/**
 * `.sdlc/config.json` must only ever originate from origin/<defaultBranch>'s
 * tracked history: an untracked stray copy survives createBranch's checkout
 * untouched and is then indistinguishable from a clean checkout to every
 * later step (including the preImageStatus === 'absent' path and --ship's
 * staging), so it is refused outright.
 */
function hasUntrackedConfig(projectRoot) {
  if (!fs.existsSync(path.join(projectRoot, '.sdlc', 'config.json'))) return false;
  const tracked = git(projectRoot, ['ls-files', '--error-unmatch', '--', CONFIG_PATH]);
  return tracked.status !== 0;
}

// ---------------------------------------------------------------------------
// R8 step 3 — pre-image capture + preImageStatus classification
// ---------------------------------------------------------------------------

/**
 * Classify via `git ls-tree` FIRST: `git show` exits 128 both for a path that
 * does not exist at the ref and for a bad ref, and the stderr text separating
 * them is git-version-dependent — so the exit code alone cannot distinguish
 * 'absent' from 'error'.
 *
 * @returns {{preImageStatus:'resolved'|'absent'|'error', preImage:object, error:string|null}}
 */
function capturePreImage(projectRoot, defaultBranch) {
  const ref = `origin/${defaultBranch}`;

  const lsTree = git(projectRoot, ['ls-tree', '--name-only', ref, '--', CONFIG_PATH]);
  if (lsTree.status !== 0) {
    return {
      preImageStatus: 'error',
      preImage: {},
      error: `cannot resolve ${ref} to classify the ${CONFIG_PATH} pre-image: ${stderrOf(lsTree)}`,
    };
  }
  if (!(lsTree.stdout || '').trim()) {
    // Legitimately absent: e.g. the first assimilation in a project that has
    // no .sdlc/config.json on the default branch yet.
    return { preImageStatus: 'absent', preImage: {}, error: null };
  }

  const show = git(projectRoot, ['show', `${ref}:${CONFIG_PATH}`]);
  if (show.status !== 0) {
    return {
      preImageStatus: 'error',
      preImage: {},
      error: `cannot read ${ref}:${CONFIG_PATH} (present per ls-tree): ${stderrOf(show)}`,
    };
  }
  let preImage;
  try {
    preImage = JSON.parse(show.stdout);
  } catch (err) {
    return {
      preImageStatus: 'error',
      preImage: {},
      error: `${ref}:${CONFIG_PATH} is not valid JSON — ${err.message}`,
    };
  }
  if (preImage === null || typeof preImage !== 'object' || Array.isArray(preImage)) {
    return {
      preImageStatus: 'error',
      preImage: {},
      error: `${ref}:${CONFIG_PATH} did not parse to a JSON object`,
    };
  }
  return { preImageStatus: 'resolved', preImage, error: null };
}

/** Flat array of signature strings (never an object/map) — anything else is ignored. */
function rejectedSignaturesOf(preImage) {
  const raw = preImage && preImage.rejected_guardrails;
  if (!Array.isArray(raw)) return [];
  return raw.filter(entry => typeof entry === 'string' && entry.trim() !== '');
}

// ---------------------------------------------------------------------------
// R6 — recurrence threshold from the `learn` section, default 3
// ---------------------------------------------------------------------------

function resolveThreshold(projectRoot) {
  const learn = readSection(projectRoot, 'learn');
  const value = learn && learn.recurrenceThreshold;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  return DEFAULT_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const cli   = parseArgs(process.argv.slice(2));
  const stdin = readStdinJson();

  const input = {};
  for (const [k, v] of Object.entries(stdin)) input[k] = v;
  for (const [k, v] of Object.entries(cli)) input[camelKey(k)] = v;

  const projectRoot = resolveSdlcRoot();
  const errors = [];

  // Captured before any checkout so learn-apply.js can restore it.
  const initialBranch = safeExec('git rev-parse --abbrev-ref HEAD', projectRoot) || null;
  const defaultBranch = (input.defaultBranch && String(input.defaultBranch).trim())
    || detectBaseBranchSafe(projectRoot);

  const manifest = {
    eligible: [],
    waiting: [],
    skipped: [],
    branchName: null,
    defaultBranch,
    initialBranch,
    preImageStatus: 'error',
    preImage: {},
    timestamp: new Date().toISOString(),
    errors,
  };

  // Read + parse pending changesets. Filtering waits for the pre-image.
  const pending = readPendingChangesets(projectRoot);
  manifest.skipped = pending.skipped;
  if (pending.fatal) {
    errors.push(pending.fatal);
    process.stderr.write(`learn-prepare: ${pending.fatal}\n`);
    writeOutput(manifest, 'sdlc-learn', 1);
    return;
  }

  // R7 short-circuit — nothing parseable, so nothing can ever qualify: skip
  // the fetch, the clean-tree scan and the branch entirely.
  if (pending.parsed.length === 0) {
    writeOutput(manifest, 'sdlc-learn', 0);
    return;
  }

  // R8 step 1 — fetch before anything resolves origin/<defaultBranch>.
  const fetched = git(projectRoot, ['fetch', 'origin', defaultBranch]);
  if (fetched.status !== 0) {
    const msg = `git fetch origin ${defaultBranch} failed — refusing to read a stale origin/${defaultBranch}: ${stderrOf(fetched)}`;
    errors.push(msg);
    process.stderr.write(`learn-prepare: ${msg}\n`);
    writeOutput(manifest, 'sdlc-learn', 1);
    return;
  }

  // R8 step 2 — clean-tree precondition (runs before eligibility is known).
  const problems = checkCleanTree(projectRoot);
  if (hasUntrackedConfig(projectRoot)) {
    problems.push(`${CONFIG_PATH} exists as an UNTRACKED file — it must come only from origin/${defaultBranch}'s tracked history. Remove or commit the stray copy before assimilating learnings.`);
  }
  if (problems.length > 0) {
    for (const p of problems) errors.push(p);
    process.stderr.write(`learn-prepare: ${problems.join('\n')}\n`);
    writeOutput(manifest, 'sdlc-learn', 1);
    return;
  }

  // R8 step 3 — pre-image capture + classification.
  const pre = capturePreImage(projectRoot, defaultBranch);
  manifest.preImageStatus = pre.preImageStatus;
  manifest.preImage = pre.preImage;
  if (pre.preImageStatus === 'error') {
    // Fail closed: abort before filtering against an incomplete rejected
    // list and before any branch is created.
    errors.push(pre.error);
    process.stderr.write(`learn-prepare: ${pre.error}\n`);
    writeOutput(manifest, 'sdlc-learn', 1);
    return;
  }

  // R8 step 0 (interleaved) — R5: the rejected list is the one from the
  // pre-image, never a local working-tree read.
  const rejected = rejectedSignaturesOf(pre.preImage);
  const rejectedSet = new Set(rejected);
  for (const item of pending.parsed) {
    if (rejectedSet.has(item.signature)) {
      manifest.skipped.push({
        filePath: item.filePath,
        reason: `signature "${item.signature}" is listed in rejected_guardrails on origin/${defaultBranch}`,
      });
    }
  }
  const kept = filterRejected(pending.parsed, rejected);
  const { eligible, waiting } = selectEligible(groupBySignature(kept), resolveThreshold(projectRoot));
  manifest.eligible = eligible;
  manifest.waiting = waiting;

  // R7 — no signature qualifies: exit 0, create no branch.
  if (eligible.length === 0) {
    writeOutput(manifest, 'sdlc-learn', 0);
    return;
  }

  // R8 step 4 — branch off the freshly fetched origin/<defaultBranch>.
  const branchName = `${BRANCH_PREFIX}${Date.now()}`;
  const created = createBranch(projectRoot, branchName, `origin/${defaultBranch}`);
  if (created !== 'created') {
    const msg = `createBranch failed for ${branchName} from origin/${defaultBranch}`;
    errors.push(msg);
    process.stderr.write(`learn-prepare: ${msg}\n`);
    writeOutput(manifest, 'sdlc-learn', 1);
    return;
  }
  manifest.branchName = branchName;

  writeOutput(manifest, 'sdlc-learn', 0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`learn-prepare.js crashed: ${err.stack || err.message}\n`);
  process.exit(2);
}
