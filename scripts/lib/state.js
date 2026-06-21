'use strict';

/**
 * state.js
 * Shared execution-state file utilities for Lift-SDLC scripts.
 * Used by both ship-state.js and execute-state.js.
 *
 * Zero npm dependencies — Node.js built-ins only.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { exec }                   = require('./git');
const { readSection, resolveSdlcRoot } = require('./config');
const { resolveMainWorktree }    = require('./worktree');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Write content to filePath atomically: write to a .tmp sibling, then rename.
 * The tmp file is placed in the same directory so fs.renameSync works across
 * same-filesystem paths without a copy.
 * @param {string} filePath  Absolute destination path
 * @param {string} content   String content to write
 */
function atomicWriteSync(filePath, content) {
  const dir    = path.dirname(filePath);
  const suffix = crypto.randomBytes(4).toString('hex');
  const tmp    = path.join(dir, path.basename(filePath) + '.' + suffix + '.tmp');
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Compact recovery TTL
// ---------------------------------------------------------------------------

/**
 * Freshness window for `.compact-recovery-<slug>.json` and for implicit
 * resume of ship state files after a /compact (issue #359). A state file
 * younger than this is considered "fresh enough" to auto-resume; older
 * files are treated as stale and ignored.
 *
 * 1 hour matches `hooks/session-start.js`'s prior in-line constant.
 *
 * @type {number} milliseconds
 */
const COMPACT_RECOVERY_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Worktree helpers — resolveMainWorktree is imported from ./worktree
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Branch slug helpers
// ---------------------------------------------------------------------------

/**
 * Convert a branch name to a filesystem-safe slug.
 * Replaces any character that is not alphanumeric or a hyphen with `-`.
 * E.g. `feat/my-feature` → `feat-my-feature`
 * @param {string} branch
 * @returns {string}
 */
function slugifyBranch(branch) {
  return branch.replace(/[^a-zA-Z0-9-]/g, '-');
}

// ---------------------------------------------------------------------------
// State directory
// ---------------------------------------------------------------------------

/**
 * Return the canonical execution state directory path.
 * Always resolves relative to the main worktree so all worktrees share state.
 * @returns {string} Absolute path: `<mainWorktree>/.sdlc/execution/`
 */
function resolveStateDir() {
  // SDLC_STATE_DIR_OVERRIDE lets test harnesses point at a fixture's .sdlc/execution/
  // without needing a real git repo in the fixture directory.
  if (process.env.SDLC_STATE_DIR_OVERRIDE) return process.env.SDLC_STATE_DIR_OVERRIDE;
  const mainWorktree = resolveMainWorktree();
  return path.join(mainWorktree, '.sdlc', 'execution');
}

// ---------------------------------------------------------------------------
// File lookup
// ---------------------------------------------------------------------------

/**
 * Find the most recent state file matching `<prefix>-<branchSlug>-*.json`.
 * @param {string} prefix      e.g. `"ship"`, `"execute"`, or `"plan"`
 * @param {string} branchSlug  Slugified branch name (via slugifyBranch)
 * @returns {{ file: string, fullPath: string } | null}
 *   `file` is relative to the state directory parent (`".sdlc/execution/<filename>"`),
 *   `fullPath` is the absolute path.
 */
function findStateFile(prefix, branchSlug) {
  const stateDir = resolveStateDir();
  if (!fs.existsSync(stateDir)) return null;

  let entries;
  try {
    entries = fs.readdirSync(stateDir);
  } catch (_) {
    return null;
  }

  // Match files like: <prefix>-<branchSlug>-<timestamp>.json
  // Use delimiter-aware matching to avoid "main" matching "fix-maintain-feature"
  const slugPattern = `${prefix}-${branchSlug}-`;
  const matching = entries
    .filter(f =>
      f.startsWith(slugPattern) &&
      f.endsWith('.json')
    )
    .map(f => {
      const fullPath = path.join(stateDir, f);
      try {
        const stat = fs.statSync(fullPath);
        return { file: path.join('.sdlc', 'execution', f), fullPath, mtime: stat.mtimeMs };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  if (matching.length === 0) return null;

  return { file: matching[0].file, fullPath: matching[0].fullPath };
}

// ---------------------------------------------------------------------------
// Resume-state detection (canonical: slugify branch + newest mtime)
// ---------------------------------------------------------------------------

/**
 * Locate the most recent `<prefix>-*.json` state file in the canonical
 * execution directory.
 *
 * Selection rule (canonical for the project):
 *   1. If `branch` is supplied, slugify it via `slugifyBranch` and filter
 *      filenames to those starting with `<prefix>-<slug>-`.
 *   2. If `branch` is omitted, accept any file with the given prefix.
 *   3. Among the survivors, pick the one with the highest mtimeMs.
 *
 * Adopted from `skill/ship.js::detectResumeState` so that both ship.js
 * (branch-scoped resume) and harden-prepare.js (latest-of-any-branch
 * read-only probe) share one implementation. Issue #284 — task 19.
 *
 * Output shape mirrors ship.js's existing `{stateFile, found}` so that
 * its caller is unchanged. `stateFile` is a path RELATIVE to the project
 * root (e.g. `.sdlc/execution/ship-foo-20260101T000000Z.json`); `fullPath`
 * is the absolute path for callers that want to read the file.
 *
 * Issue #359 — additional fields returned for ship-prepare's implicit-resume
 * gate:
 *   - `fresh` — true when the selected file's mtime is within
 *     `COMPACT_RECOVERY_TTL_MS` of now. Stale state files are still reported
 *     (`found: true`) so callers can render a "stale, run --resume <path>"
 *     hint, but implicit resume should require `fresh === true`.
 *   - `nextPendingStep` — the `name` of the first step in `data.steps[]` whose
 *     `status` is neither `"completed"` nor `"skipped"` (the canonical
 *     terminal statuses per state-format.md). `null` when all steps are
 *     resolved, or when the state file is unreadable / has no `steps[]`.
 *
 * @param {object} opts
 * @param {string}  opts.prefix      "ship" | "execute" | "plan"
 * @param {string} [opts.branch]     If provided, restricts to this branch's slug.
 * @returns {{stateFile: string|null, fullPath: string|null, found: boolean,
 *           fresh: boolean, nextPendingStep: string|null}}
 */
function detectResumeState({ prefix, branch } = {}) {
  const empty = { stateFile: null, fullPath: null, found: false, fresh: false, nextPendingStep: null };
  if (!prefix) return empty;

  const stateDir = resolveStateDir();
  if (!fs.existsSync(stateDir)) return empty;

  let entries;
  try {
    entries = fs.readdirSync(stateDir);
  } catch (_) {
    return empty;
  }

  const branchSlug = branch ? slugifyBranch(branch) : null;
  const namePrefix = branchSlug ? `${prefix}-${branchSlug}-` : `${prefix}-`;

  const matching = entries
    .filter(f => f.startsWith(namePrefix) && f.endsWith('.json'))
    .map(f => {
      const fullPath = path.join(stateDir, f);
      try {
        const stat = fs.statSync(fullPath);
        return {
          file: path.join('.sdlc', 'execution', f),
          fullPath,
          mtime: stat.mtimeMs,
        };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  if (matching.length === 0) return empty;

  const winner = matching[0];
  const fresh = (Date.now() - winner.mtime) <= COMPACT_RECOVERY_TTL_MS;

  // R-step-result-fields (#359): derive nextPendingStep by parsing the
  // selected state file. Defensive — corrupt/unreadable file yields null
  // (caller treats null as "no resumable step name surfaced").
  let nextPendingStep = null;
  try {
    const raw = fs.readFileSync(winner.fullPath, 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.steps)) {
      const pending = data.steps.find(s => s && s.status !== 'completed' && s.status !== 'skipped');
      if (pending && typeof pending.name === 'string') {
        nextPendingStep = pending.name;
      }
    }
  } catch (_) {
    // Leave nextPendingStep as null.
  }

  return {
    stateFile: winner.file,
    fullPath: winner.fullPath,
    found: true,
    fresh,
    nextPendingStep,
  };
}

// ---------------------------------------------------------------------------
// Read / write / init / delete
// ---------------------------------------------------------------------------

/**
 * Read and parse the most recent state file for a given prefix + branch.
 * @param {string} prefix
 * @param {string} branchSlug
 * @returns {{ data: object, filePath: string } | null}
 */
function readState(prefix, branchSlug) {
  const found = findStateFile(prefix, branchSlug);
  if (!found) return null;

  try {
    const raw = fs.readFileSync(found.fullPath, 'utf8');
    const data = JSON.parse(raw);
    return { data, filePath: found.fullPath };
  } catch (_) {
    process.stderr.write(`[state] Warning: corrupt or unreadable state file: ${found.fullPath}\n`);
    return null;
  }
}

/**
 * Write JSON state to an existing file path (overwrites).
 * @param {string} filePath  Absolute path to the state file
 * @param {object} data
 */
function writeState(filePath, data) {
  atomicWriteSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Create a new state file in the state directory.
 * File name format: `<prefix>-<branchSlug>-<YYYYMMDDTHHmmssZ>.json`
 * @param {string} prefix   e.g. `"ship"`, `"execute"`, or `"plan"`
 * @param {string} branch   Raw branch name (will be slugified internally)
 * @param {object} data     Initial state data
 * @returns {string}  Absolute path to the created file
 */
function initState(prefix, branch, data) {
  const stateDir = resolveStateDir();
  fs.mkdirSync(stateDir, { recursive: true });

  const branchSlug = slugifyBranch(branch);
  const timestamp  = new Date()
    .toISOString()
    .replace(/[-:]/g, '')   // remove dashes and colons
    .replace(/\.\d+Z$/, 'Z'); // drop milliseconds, keep Z

  const fileName = `${prefix}-${branchSlug}-${timestamp}.json`;
  const filePath = path.join(stateDir, fileName);

  atomicWriteSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

/**
 * Write a survival-grade manifest blob to the state directory.
 * Unlike `initState`, this does NOT wrap data in a pipeline state schema —
 * it writes the data verbatim (for prepare-script manifests like commit-context).
 *
 * Prune-on-write: removes pre-existing `<prefix>-<branchSlug>-*.json` files
 * for the same branch before writing the new file.
 *
 * @param {string} prefix  e.g. `"commit"`
 * @param {string} branch  Raw branch name (will be slugified internally)
 * @param {object} data    Data to write verbatim (JSON.stringify'd)
 * @returns {string}  Absolute path to the created file
 */
function writeManifestState(prefix, branch, data) {
  const stateDir = resolveStateDir();
  fs.mkdirSync(stateDir, { recursive: true });

  const branchSlug = slugifyBranch(branch);

  // Prune-on-write: remove stale same-branch manifests before writing.
  pruneStateFiles(prefix, branchSlug);

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

  const fileName = `${prefix}-${branchSlug}-${timestamp}.json`;
  const filePath = path.join(stateDir, fileName);

  atomicWriteSync(filePath, JSON.stringify(data, null, 2) + '\n');
  return filePath;
}

/**
 * Delete a state file. Ignores errors if the file does not exist.
 * @param {string} filePath  Absolute path to the state file
 */
function deleteState(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (_) {
    // Intentionally ignored — file may have already been removed.
  }
}

// ---------------------------------------------------------------------------
// Branch resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the current git branch name. Uses the provided argument if given,
 * otherwise detects via `git branch --show-current`.
 * @param {string|undefined} argBranch  Explicit branch name from CLI args
 * @returns {string}
 */
function resolveBranch(argBranch) {
  if (argBranch) return argBranch;
  const branch = exec('git branch --show-current');
  if (!branch) {
    throw new Error('Could not determine current branch');
  }
  return branch;
}

// ---------------------------------------------------------------------------
// Garbage collection
// ---------------------------------------------------------------------------

/**
 * Parse a state-file basename into its components.
 * Format: <prefix>-<branchSlug>-<timestamp>.json
 *
 * The slug may itself contain dashes (e.g. `fix-220-foo`) and the timestamp
 * is always 16 chars of `YYYYMMDDTHHmmssZ`. We anchor on the trailing
 * `-<timestamp>.json` so the slug captures everything between the prefix and
 * the timestamp regardless of internal dashes.
 *
 * @param {string} name  basename (no directory)
 * @returns {{prefix: string, slug: string, timestamp: string} | null}
 */
function parseStateFilename(name) {
  // Trailing `-<16 chars>.json` where timestamp pattern is ISO-compact:
  // 8 digits (date) + 'T' + 6 digits (time) + 'Z'.
  const m = name.match(/^(ship|execute|plan|commit)-(.+)-(\d{8}T\d{6}Z)\.json$/);
  if (!m) return null;
  return { prefix: m[1], slug: m[2], timestamp: m[3] };
}

/**
 * Garbage-collect stale state files in `<mainWorktree>/.sdlc/execution/`.
 *
 * Pure function: takes an explicit `knownBranches` list and `now` timestamp
 * (no shell-out, no clock read) so it is deterministic and unit-testable.
 *
 * Pruning rule:
 *   - File mtime within TTL → KEEP, reason "ttl-fresh".
 *   - File branch (slug-matched against knownBranches) is currently live → KEEP, reason "branch-exists".
 *   - File is older than TTL AND its branch is gone → DELETE, reason "stale+branch-gone".
 *   - Filename does not match `<prefix>-<slug>-<timestamp>.json` → KEEP, reason "unparseable-name" (warn-and-skip).
 *
 * Slug matching: branches in `knownBranches` may contain `/` and other chars
 * that get collapsed by `slugifyBranch`. Match by slug equality after
 * slugifying every known branch, NOT by reverse-mapping the slug.
 *
 * @param {object} opts
 * @param {string|null} [opts.prefix]    "ship" | "execute" | null (both)
 * @param {number}      [opts.ttlDays=7] retention window in days
 * @param {string[]}    opts.knownBranches  current `git branch --list` output
 * @param {number}      [opts.now]       current time (ms); defaults to Date.now()
 * @returns {{ deleted: Array<{file,prefix,branch,mtime,reason}>, kept: Array<{file,prefix,branch,reason}> }}
 */
function gcStateFiles({ prefix = null, ttlDays = 7, knownBranches = [], now } = {}) {
  const stateDir = resolveStateDir();
  const result = { deleted: [], kept: [] };

  if (!fs.existsSync(stateDir)) return result;

  let entries;
  try {
    entries = fs.readdirSync(stateDir);
  } catch (_) {
    return result;
  }

  const nowMs = typeof now === 'number' ? now : Date.now();
  const ttlMs = ttlDays * 86400000;
  const liveSlugs = new Set(knownBranches.map(slugifyBranch));

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;

    const parsed = parseStateFilename(name);
    if (!parsed) {
      result.kept.push({ file: name, prefix: null, branch: null, reason: 'unparseable-name' });
      continue;
    }

    if (prefix && parsed.prefix !== prefix) continue;

    const fullPath = path.join(stateDir, name);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (_) {
      continue;
    }

    const ageMs = nowMs - stat.mtimeMs;
    const branchExists = liveSlugs.has(parsed.slug);

    if (ageMs < ttlMs) {
      result.kept.push({ file: name, prefix: parsed.prefix, branch: parsed.slug, reason: 'ttl-fresh' });
      continue;
    }

    if (branchExists) {
      result.kept.push({ file: name, prefix: parsed.prefix, branch: parsed.slug, reason: 'branch-exists' });
      continue;
    }

    try {
      fs.unlinkSync(fullPath);
      result.deleted.push({
        file: name,
        prefix: parsed.prefix,
        branch: parsed.slug,
        mtime: stat.mtimeMs,
        reason: 'stale+branch-gone',
      });
    } catch (_) {
      // Best-effort: another process may have deleted it; report as kept.
      result.kept.push({ file: name, prefix: parsed.prefix, branch: parsed.slug, reason: 'unlink-failed' });
    }
  }

  return result;
}

/**
 * Init-time orphan prune for a single (prefix, branchSlug) pair.
 *
 * Unconditionally removes all `<prefix>-<branchSlug>-<timestamp>.json` files
 * in `<mainWorktree>/.sdlc/execution/`. Unlike `gcStateFiles`, this DOES NOT
 * consult TTL or branch-existence — same-branch state files predating a new
 * `init` are by definition orphans (one branch hosts one active pipeline).
 *
 * Implements R-ship-init-prune (issue #255).
 *
 * @param {string} prefix      "ship" | "execute" | "plan"
 * @param {string} branchSlug  branch slug as produced by `slugifyBranch`
 * @returns {string[]} filenames that were removed (basename only, not absolute paths)
 */
function pruneStateFiles(prefix, branchSlug) {
  const stateDir = resolveStateDir();
  if (!fs.existsSync(stateDir)) return [];

  let entries;
  try {
    entries = fs.readdirSync(stateDir);
  } catch (_) {
    return [];
  }

  const removed = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const parsed = parseStateFilename(name);
    if (!parsed) continue;
    if (parsed.prefix !== prefix) continue;
    if (parsed.slug !== branchSlug) continue;

    try {
      fs.unlinkSync(path.join(stateDir, name));
      removed.push(name);
    } catch (_) {
      // best-effort; another process may have removed it
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Branch-slug migration
// ---------------------------------------------------------------------------

/**
 * Rename a state file to use a new branch slug, preserving its timestamp,
 * and update `data.branch` to the new branch name.
 *
 * Atomicity: we read the JSON, atomic-write to the new path (via temp
 * file + rename), then unlink the old path. This is the same pattern used
 * for `writeState`/`initState` — a brief window where both files exist on
 * disk after the new write but before the old delete is acceptable; readers
 * (`findStateFile`) sort by mtime descending and would pick the newest.
 *
 * @param {object} opts
 * @param {string} opts.prefix     "ship" | "execute"
 * @param {string} opts.fromSlug   Current slug (already slugified)
 * @param {string} opts.toBranch   New branch name (raw — slugified internally)
 * @returns {{migrated: true, from: string, to: string, filePath: string}
 *         | {migrated: false, reason: string}}
 */
function migrateBranchSlug({ prefix, fromSlug, toBranch }) {
  if (!prefix || !fromSlug || !toBranch) {
    return { migrated: false, reason: 'missing-args' };
  }

  const found = findStateFile(prefix, fromSlug);
  if (!found) {
    return { migrated: false, reason: 'no-state-file' };
  }

  const stateDir   = resolveStateDir();
  const oldName    = path.basename(found.fullPath);
  const parsed     = parseStateFilename(oldName);
  if (!parsed) {
    return { migrated: false, reason: 'unparseable-name' };
  }

  const newSlug = slugifyBranch(toBranch);
  if (newSlug === parsed.slug) {
    return { migrated: false, reason: 'same-slug' };
  }

  const newName = `${prefix}-${newSlug}-${parsed.timestamp}.json`;
  const newPath = path.join(stateDir, newName);

  let raw;
  try {
    raw = fs.readFileSync(found.fullPath, 'utf8');
  } catch (e) {
    return { migrated: false, reason: `read-failed: ${e.message}` };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { migrated: false, reason: `parse-failed: ${e.message}` };
  }

  data.branch = toBranch;

  try {
    atomicWriteSync(newPath, JSON.stringify(data, null, 2));
  } catch (e) {
    return { migrated: false, reason: `write-failed: ${e.message}` };
  }

  // Unlink the old file. If the new and old paths somehow collide
  // (shouldn't, since slugs differ by check above), don't delete what we just wrote.
  if (newPath !== found.fullPath) {
    try {
      fs.unlinkSync(found.fullPath);
    } catch (_) {
      // Non-fatal: the new file is in place; orphan will be GC'd.
    }
  }

  return {
    migrated: true,
    from: oldName,
    to: newName,
    filePath: newPath,
  };
}

// ---------------------------------------------------------------------------
// GC helpers shared by state/ship.js and state/execute.js
// ---------------------------------------------------------------------------

/**
 * Return list of local branch names via `git branch --list`.
 * @returns {string[]}
 */
function listBranches() {
  try {
    const out = exec("git branch --list --format='%(refname:short)'");
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Read `state.gc.ttlDays` from `.sdlc/config.json`, falling back to 7.
 * @returns {number}
 */
function readTtlDaysFromConfig() {
  try {
    // issue #351: route to main worktree's .sdlc/ so linked-worktree cwds
    // still pick up the developer-configured ttlDays value.
    const stateCfg = readSection(resolveSdlcRoot(), 'state');
    const v = stateCfg && stateCfg.gc && stateCfg.gc.ttlDays;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  } catch (_) {
    // fall through to default
  }
  return 7;
}

/**
 * Garbage-collect stale per-invocation tempdirs created by plan-explore.js.
 *
 * Tempdirs follow the naming convention:
 *   sdlc-explore-<branchSlug>-XXXXXX
 * where XXXXXX is a random suffix appended by `fs.mkdtempSync`.
 *
 * Pruning rule (mirrors gcStateFiles semantics):
 *   - Dir mtime within TTL → KEEP, reason "ttl-fresh".
 *   - Dir branch (slug extracted from name) is currently live → KEEP, reason "branch-exists".
 *   - Dir is older than TTL AND its branch is gone → DELETE (rm -rf), reason "stale+branch-gone".
 *   - Name doesn't start with prefix → silently skipped.
 *   - Name matches prefix but slug can't be extracted → KEEP, reason "unparseable-name".
 *
 * Note: `parseStateFilename` is NOT used here — tempdirs are not state files.
 *
 * @param {object} opts
 * @param {string}   opts.prefix          directory name prefix, e.g. "sdlc-explore-"
 * @param {number}   [opts.ttlDays=7]     retention window in days
 * @param {string[]} opts.knownBranches   current `git branch --list` output (raw branch names)
 * @param {number}   [opts.now]           current time (ms); defaults to Date.now()
 * @param {string}   [opts.tmpdir]        override os.tmpdir() for testing
 * @returns {{ deleted: Array<{dir,branch,mtime,reason}>, kept: Array<{dir,branch,reason}> }}
 */
function gcTempdirs({ prefix, ttlDays = 7, knownBranches = [], now, tmpdir } = {}) {
  const os = require('os');
  const scanDir = tmpdir || os.tmpdir();
  const result = { deleted: [], kept: [] };

  if (!prefix) return result;

  let entries;
  try {
    entries = fs.readdirSync(scanDir);
  } catch (_) {
    return result;
  }

  const nowMs    = typeof now === 'number' ? now : Date.now();
  const ttlMs    = ttlDays * 86400000;
  const liveSlugs = new Set(knownBranches.map(slugifyBranch));

  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;

    // Extract branchSlug: everything between prefix and the random suffix.
    // Convention: sdlc-explore-<branchSlug>-XXXXXX
    // The random suffix from mkdtempSync is 6 alphanumeric chars with no dash.
    // Split on '-' and drop the last segment (random suffix).
    const afterPrefix = name.slice(prefix.length);
    const parts = afterPrefix.split('-');
    if (parts.length < 2) {
      // No suffix segment — can't determine branch slug
      result.kept.push({ dir: name, branch: null, reason: 'unparseable-name' });
      continue;
    }
    const branchSlug = parts.slice(0, -1).join('-');

    const fullPath = path.join(scanDir, name);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (_) {
      continue; // disappeared between readdir and stat
    }

    if (!stat.isDirectory()) continue;

    const ageMs = nowMs - stat.mtimeMs;
    const branchExists = liveSlugs.has(branchSlug);

    if (ageMs < ttlMs) {
      result.kept.push({ dir: name, branch: branchSlug, reason: 'ttl-fresh' });
      continue;
    }

    if (branchExists) {
      result.kept.push({ dir: name, branch: branchSlug, reason: 'branch-exists' });
      continue;
    }

    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
      result.deleted.push({
        dir: name,
        branch: branchSlug,
        mtime: stat.mtimeMs,
        reason: 'stale+branch-gone',
      });
    } catch (_) {
      result.kept.push({ dir: name, branch: branchSlug, reason: 'unlink-failed' });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// priorWaveContext summarizer (R-BYTE-BUDGET / R-CONTEXT_OVERFLOW hardening, #432)
// ---------------------------------------------------------------------------

/**
 * Return a bounded slice of the execution state's priorWaveContext fields.
 *
 * The priorWaveContext object accumulates `filesAdded`, `filesModified`,
 * `interfacesCreated`, and `decisionsFromPriorWaves` monotonically with no
 * cap. Passing an unbounded context object to each wave-runner agent inflates
 * per-agent context proportionally with wave count. This function caps each
 * field to the most-recent N entries so the byte footprint stays bounded.
 *
 * Defaults can be overridden via `.sdlc/config.json` under
 * `execute.priorWaveContextCaps`:
 *   { maxFiles: 20, maxDecisions: 10, maxInterfaces: 15 }
 *
 * @param {object} state                   - execute state object (from readState)
 * @param {object} [opts]
 * @param {number} [opts.maxFiles=20]       - max filesAdded + filesModified entries each
 * @param {number} [opts.maxDecisions=10]   - max decisionsFromPriorWaves entries
 * @param {number} [opts.maxInterfaces=15]  - max interfacesCreated entries
 * @returns {{ planSummary: string, completedTaskIds: string[], filesAdded: string[], filesModified: string[], interfacesCreated: string[], decisionsFromPriorWaves: string[] }}
 */
function summarizePriorWaveContext(state, opts = {}) {
  const ctx = (state && state.context) ? state.context : {};

  // Load caps from config if available; fall back to opts then defaults
  let configCaps = {};
  try {
    const { readSection, resolveSdlcRoot } = require('./config');
    const execSection = readSection(resolveSdlcRoot(), 'execute') || {};
    configCaps = execSection.priorWaveContextCaps || {};
  } catch (_) {
    // config not available or malformed — use defaults
  }

  const maxFiles      = opts.maxFiles      != null ? opts.maxFiles      : (configCaps.maxFiles      || 20);
  const maxDecisions  = opts.maxDecisions  != null ? opts.maxDecisions  : (configCaps.maxDecisions  || 10);
  const maxInterfaces = opts.maxInterfaces != null ? opts.maxInterfaces : (configCaps.maxInterfaces || 15);

  /**
   * Return the last N items from an array, or the full array if shorter.
   * @param {any[]} arr
   * @param {number} n
   */
  function tail(arr, n) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(-n);
  }

  return {
    planSummary:              ctx.planSummary              || '',
    completedTaskIds:         Array.isArray(ctx.completedTaskIds) ? [...ctx.completedTaskIds] : [],
    filesAdded:               tail(ctx.filesAdded,               maxFiles),
    filesModified:            tail(ctx.filesModified,            maxFiles),
    interfacesCreated:        tail(ctx.interfacesCreated,        maxInterfaces),
    decisionsFromPriorWaves:  tail(ctx.decisionsFromPriorWaves,  maxDecisions),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  resolveMainWorktree,
  slugifyBranch,
  resolveStateDir,
  findStateFile,
  readState,
  writeState,
  initState,
  writeManifestState,
  deleteState,
  resolveBranch,
  detectResumeState,
  parseStateFilename,
  gcStateFiles,
  gcTempdirs,
  pruneStateFiles,
  migrateBranchSlug,
  listBranches,
  readTtlDaysFromConfig,
  COMPACT_RECOVERY_TTL_MS,
  summarizePriorWaveContext,
};
