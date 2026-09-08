'use strict';

/**
 * Filesystem-bound approval / critique artifact store for R21.
 *
 * The skill writes:
 *   - $TMPDIR/jira-sdlc/critique-<hash>.json   (R20 critique block)
 *   - $TMPDIR/jira-sdlc/approval-<hash>.token  (R17 approval grant)
 *
 * Before dispatching a write MCP call, the LLM re-derives <hash> from the
 * final `tool_input` and verifies both files exist with mtime < TTL_MS, then
 * consumes (deletes) them on success. There is no hook backstop —
 * `hooks/pre-tool-jira-write-guard.js` does not exist and is not registered in
 * `hooks.json`; this check is the skill's own (see SKILL.md Step 3). Atomic
 * writes (tmp+rename) so a reader never sees a partial file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000; // 10 minutes

// Canonicalize tmpdir once at module load to resolve macOS symlinks
// (`/var/folders/...` → `/private/var/folders/...`). Writers and readers are
// both the skill itself, so they inherit the same canonical base and can
// reliably locate artifacts regardless of which symlink form `os.tmpdir()`
// returned at process start.
const TMPDIR_REAL = fs.realpathSync(os.tmpdir());

function storeDir() {
  return path.join(TMPDIR_REAL, 'jira-sdlc');
}

function ensureDir() {
  const dir = storeDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function critiquePath(hash) {
  return path.join(storeDir(), `critique-${hash}.json`);
}

function approvalPath(hash) {
  return path.join(storeDir(), `approval-${hash}.token`);
}

function atomicWrite(targetPath, contents) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, targetPath);
}

/**
 * Persist a critique artifact. Shape: {initial, findings: string[], final}.
 * Throws on shape violations to fail loudly during skill development.
 */
function writeCritique(hash, payload) {
  if (!hash || typeof hash !== 'string') throw new TypeError('writeCritique: hash required');
  if (!payload || typeof payload !== 'object') throw new TypeError('writeCritique: payload object required');
  if (typeof payload.initial !== 'string' || typeof payload.final !== 'string'
    || !Array.isArray(payload.findings)) {
    throw new TypeError('writeCritique: payload must be {initial, findings:[], final}');
  }
  ensureDir();
  atomicWrite(critiquePath(hash), JSON.stringify(payload));
}

/**
 * Persist an approval token. Body is the timestamp; mtime drives the TTL.
 */
function writeApprovalToken(hash) {
  if (!hash || typeof hash !== 'string') throw new TypeError('writeApprovalToken: hash required');
  ensureDir();
  atomicWrite(approvalPath(hash), String(Date.now()));
}

/**
 * Scan storeDir for any approval-<hex>.token files and return up to 3 hash
 * prefixes (sorted lexicographically). Used by the hook to surface the
 * artifact-side hash(es) when a hash-mismatch deny is emitted (spec R21).
 *
 * @returns {string[]} full 64-hex hashes; truncation happens at the call site.
 */
function listArtifactHashes() {
  const dir = storeDir();
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const hashes = [];
  for (const name of entries) {
    const m = /^approval-([0-9a-f]{64})\.token$/.exec(name);
    if (m) hashes.push(m[1]);
  }
  hashes.sort();
  return hashes.slice(0, 3);
}

/**
 * Verify both artifacts exist, are readable, well-formed, and not stale.
 *
 * @returns {{ approval: boolean, critique: boolean, ageMs: number, reason: string|null, nearbyArtifactHashes: string[] }}
 */
function verifyArtifacts(hash) {
  const out = {
    approval: false,
    critique: false,
    ageMs: Infinity,
    reason: null,
    nearbyArtifactHashes: [],
  };
  const aPath = approvalPath(hash);
  const cPath = critiquePath(hash);

  let aStat, cStat;
  try { aStat = fs.statSync(aPath); } catch { /* missing */ }
  try { cStat = fs.statSync(cPath); } catch { /* missing */ }

  if (!aStat) {
    out.reason = 'approval token missing';
    out.nearbyArtifactHashes = listArtifactHashes();
    return out;
  }
  if (!cStat) {
    out.reason = 'critique artifact missing';
    out.nearbyArtifactHashes = listArtifactHashes();
    return out;
  }

  const now = Date.now();
  const ageMs = Math.min(now - aStat.mtimeMs, now - cStat.mtimeMs);
  out.ageMs = ageMs;
  if (now - aStat.mtimeMs > TTL_MS) {
    out.reason = 'approval token stale (> 10 min)';
    return out;
  }
  if (now - cStat.mtimeMs > TTL_MS) {
    out.reason = 'critique artifact stale (> 10 min)';
    return out;
  }

  // Validate critique JSON shape
  try {
    const data = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    if (typeof data.initial !== 'string' || typeof data.final !== 'string'
      || !Array.isArray(data.findings)) {
      out.reason = 'critique artifact malformed';
      return out;
    }
  } catch (e) {
    out.reason = 'critique artifact unreadable';
    return out;
  }

  out.approval = true;
  out.critique = true;
  return out;
}

/**
 * Delete approval + critique files for the given hash. Best-effort.
 */
function consumeArtifacts(hash) {
  for (const p of [approvalPath(hash), critiquePath(hash)]) {
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }
}

/**
 * Delete any artifact older than TTL_MS regardless of hash. Used by the hook
 * to keep the directory bounded even when dispatches never happen.
 */
function purgeStale() {
  const dir = storeDir();
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs > TTL_MS) fs.unlinkSync(full);
    } catch { /* race with another process */ }
  }
}

module.exports = {
  TTL_MS,
  storeDir,
  critiquePath,
  approvalPath,
  writeCritique,
  writeApprovalToken,
  verifyArtifacts,
  consumeArtifacts,
  purgeStale,
  listArtifactHashes,
};
