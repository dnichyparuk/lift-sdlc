'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { CURRENT_SCHEMA_VERSION } = require('./config-version.js');
const { PRESET_TO_STEPS } = require('./config-migrations.js');
const { resolveMainWorktreeSafe } = require('./worktree');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_CONFIG_PATH = path.join('.sdlc', 'config.json');
const LOCAL_CONFIG_PATH = path.join('.sdlc', 'local.json');

const PROJECT_SCHEMA_URL =
  'https://raw.githubusercontent.com/dnichyparuk/lift-sdlc/main/schemas/sdlc-config.schema.json';
const LOCAL_SCHEMA_URL =
  'https://raw.githubusercontent.com/dnichyparuk/lift-sdlc/main/schemas/sdlc-local.schema.json';

const PRESET_NAMES = ['full', 'balanced', 'minimal'];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file. Returns null if the file does not exist.
 * Throws on invalid JSON.
 */
function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in "${filePath}": ${err.message}`);
  }
}

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

/**
 * Write an object as pretty-printed JSON, creating parent directories as needed.
 */
function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Strip keys that belong to legacy per-file schemas but not to the unified section.
 */
function stripMeta(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return obj;
  const copy = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
}

// ---------------------------------------------------------------------------
// Verbose config-read tracing (issue #351)
// ---------------------------------------------------------------------------

/** Tracks absolute paths already traced this process (dedupe). */
const _tracedPaths = new Set();

/**
 * Emit a single-line trace to stderr for a config file read or write.
 * - Deduplicates per absolute path per process.
 * - Suppressed entirely when SDLC_CONFIG_QUIET=1.
 * - Never writes to stdout.
 *
 * @param {string} absPath   Absolute path to the config file.
 * @param {'read'|'read-miss'|'write'} status
 */
function _traceRead(absPath, status) {
  if (process.env.SDLC_CONFIG_QUIET === '1') return;
  if (_tracedPaths.has(absPath)) return;
  _tracedPaths.add(absPath);
  process.stderr.write(`[sdlc:config] ${status} ${absPath}\n`);
}

// ---------------------------------------------------------------------------
// Main-worktree rooted .sdlc root (issue #351)
// ---------------------------------------------------------------------------

/**
 * Return the main worktree root path, anchored via git rather than the
 * current working directory. When called from inside a linked worktree,
 * returns the main worktree root so that `.sdlc/config.json` and
 * `.sdlc/local.json` reads are always rooted at the developer-controlled
 * config files (not a per-branch shadow copy).
 *
 * Callers should pass the result as `projectRoot` to readSection/writeSection
 * instead of `process.cwd()`.
 *
 * Uses resolveMainWorktreeSafe (never throws; falls back to cwd when git is
 * unavailable — e.g. first-time setup before git init).
 *
 * @param {object}  [opts]
 * @param {string}  [opts.cwd=process.cwd()]  Working directory override.
 * @returns {string} Absolute path to the main worktree root (parent of `.sdlc/`).
 */
function resolveSdlcRoot({ cwd } = {}) {
  return resolveMainWorktreeSafe(cwd || process.cwd());
}

// ---------------------------------------------------------------------------
// readProjectConfig
// ---------------------------------------------------------------------------

/**
 * Read the unified project config (.sdlc/config.json).
 *
 * @param {string} projectRoot
 * @returns {{ config: object|null, sources: string[] }}
 */
function readProjectConfig(projectRoot) {
  const newPath = path.join(projectRoot, PROJECT_CONFIG_PATH);
  const config = readJsonFile(newPath);
  _traceRead(path.resolve(newPath), config ? 'read' : 'read-miss');
  return { config: config || null, sources: config ? [PROJECT_CONFIG_PATH] : [] };
}

// ---------------------------------------------------------------------------
// readLocalConfig
// ---------------------------------------------------------------------------

/**
 * Read the local (gitignored) config (.sdlc/local.json).
 *
 * @param {string} projectRoot
 * @returns {{ config: object|null, sources: string[] }}
 */
function readLocalConfig(projectRoot) {
  const localPath = path.join(projectRoot, LOCAL_CONFIG_PATH);
  const config = readJsonFile(localPath);
  _traceRead(path.resolve(localPath), config ? 'read' : 'read-miss');
  return { config: config || null, sources: config ? [LOCAL_CONFIG_PATH] : [] };
}

// ---------------------------------------------------------------------------
// readSection
// ---------------------------------------------------------------------------

/** Sections that live in the project config vs local config. */
const PROJECT_SECTIONS = new Set(['version', 'jira', 'commit', 'pr', 'plan', 'execute']);

/**
 * Read a single config section by name.
 *
 * @param {string} projectRoot
 * @param {string} section — one of 'version', 'commit', 'jira', 'pr', 'ship', 'review', 'receivedReview'
 * @returns {object|null}
 */
function readSection(projectRoot, section) {
  if (PROJECT_SECTIONS.has(section)) {
    const { config } = readProjectConfig(projectRoot);
    return config?.[section] ?? null;
  }
  if (section === 'ship') {
    const { config } = readLocalConfig(projectRoot);
    return config?.ship ?? null;
  }
  if (section === 'review') {
    const { config } = readLocalConfig(projectRoot);
    return config?.review ?? null;
  }
  if (section === 'receivedReview') {
    const { config } = readLocalConfig(projectRoot);
    return config?.receivedReview ?? null;
  }
  // issue #351: workspace and state sections live in local config
  if (section === 'workspace') {
    const { config } = readLocalConfig(projectRoot);
    return config?.workspace ?? null;
  }
  if (section === 'state') {
    const { config } = readLocalConfig(projectRoot);
    return config?.state ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// writeProjectConfig
// ---------------------------------------------------------------------------

/**
 * Write the unified project config (.sdlc/config.json).
 * Uses read-merge-write to avoid clobbering sections written by other skills.
 * Always stamps `schemaVersion: CURRENT_SCHEMA_VERSION` (issue #232) so
 * subsequent reads short-circuit verifyAndMigrate.
 *
 * @param {string} projectRoot
 * @param {object} config — partial or full config to merge
 */
function writeProjectConfig(projectRoot, config) {
  const filePath = path.join(projectRoot, PROJECT_CONFIG_PATH);
  let existing = readJsonFile(filePath) || {};
  const merged = {
    ...existing,
    ...config,
    schemaVersion: config.schemaVersion != null ? config.schemaVersion : CURRENT_SCHEMA_VERSION,
    $schema: PROJECT_SCHEMA_URL,
  };
  writeJsonFile(filePath, merged);
  _traceRead(path.resolve(filePath), 'write');
}

// ---------------------------------------------------------------------------
// computeConfigDiff (issue #235 — pre-write diff preview)
// ---------------------------------------------------------------------------

/**
 * Compute a flat diff between two JSON-serializable objects (deep). Pure: no
 * I/O, no mutation. Used by setup-sdlc Step 4 to render an end-of-run diff
 * preview before invoking writeProjectConfig / writeLocalConfig.
 *
 * Walks every key from `before ∪ after`, recursing into plain objects and
 * comparing leaf values via `JSON.stringify` for stable equality across
 * primitives, arrays, and nested objects.
 *
 * Returns:
 *   - changed: array of `{ path, before, after }` rows in stable insertion order
 *   - unchanged: count of leaf paths whose value did not change
 *
 * Examples:
 *   computeConfigDiff({a:1}, {a:2, b:3})
 *     → { changed: [{path:'a', before:1, after:2}, {path:'b', before:undefined, after:3}], unchanged: 0 }
 *   computeConfigDiff({a:{x:1}}, {a:{x:1, y:2}})
 *     → { changed: [{path:'a.y', before:undefined, after:2}], unchanged: 1 }
 *
 * @param {object} before — config snapshot before changes
 * @param {object} after — config snapshot after changes
 * @returns {{ changed: Array<{path: string, before: any, after: any}>, unchanged: number }}
 */
function computeConfigDiff(before, after) {
  const changed = [];
  let unchanged = 0;
  const isPlainObject = (v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

  function walk(b, a, prefix) {
    const keys = new Set([
      ...(b && typeof b === 'object' ? Object.keys(b) : []),
      ...(a && typeof a === 'object' ? Object.keys(a) : []),
    ]);
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const bv = b == null ? undefined : b[key];
      const av = a == null ? undefined : a[key];

      if (isPlainObject(bv) && isPlainObject(av)) {
        walk(bv, av, path);
        continue;
      }

      const bs = JSON.stringify(bv);
      const as = JSON.stringify(av);
      if (bs === as) {
        unchanged += 1;
      } else {
        changed.push({ path, before: bv, after: av });
      }
    }
  }

  walk(before || {}, after || {}, '');
  return { changed, unchanged };
}

// ---------------------------------------------------------------------------
// writeLocalConfig
// ---------------------------------------------------------------------------

/**
 * Write the local config (.sdlc/local.json).
 * Uses read-merge-write to avoid clobbering sections written by other skills.
 *
 * @param {string} projectRoot
 * @param {object} config — partial or full config to merge
 */
function writeLocalConfig(projectRoot, config) {
  const filePath = path.join(projectRoot, LOCAL_CONFIG_PATH);
  let existing = readJsonFile(filePath) || {};
  // Issue #232: stamp schemaVersion at the top level. Caller-supplied
  // overrides are honored (so an explicit schemaVersion: N still wins) but
  // the default is CURRENT_SCHEMA_VERSION. The legacy `version` field is
  // dropped from any pre-existing data — it is renamed to `schemaVersion`
  // by the v2→v3 migration step. $schema URL is fixed.
  const { version: _droppedLegacyVersion, ...existingClean } = existing;
  const merged = {
    ...existingClean,
    ...config,
    schemaVersion: config.schemaVersion != null ? config.schemaVersion : CURRENT_SCHEMA_VERSION,
    $schema: LOCAL_SCHEMA_URL,
  };
  writeJsonFile(filePath, merged);
  _traceRead(path.resolve(filePath), 'write');
}

// ---------------------------------------------------------------------------
// writeSection
// ---------------------------------------------------------------------------

/**
 * Convenience: read config, update one section, write back.
 *
 * @param {string} projectRoot
 * @param {string} section — one of 'version', 'ship', 'jira', 'review'
 * @param {object} value
 */
function writeSection(projectRoot, section, value) {
  if (PROJECT_SECTIONS.has(section)) {
    writeProjectConfig(projectRoot, { [section]: value });
  } else if (section === 'ship') {
    writeLocalConfig(projectRoot, { ship: value });
  } else if (section === 'review') {
    writeLocalConfig(projectRoot, { review: value });
  } else if (section === 'receivedReview') {
    writeLocalConfig(projectRoot, { receivedReview: value });
  } else if (section === 'workspace') {
    // issue #351: workspace lives in local config
    writeLocalConfig(projectRoot, { workspace: value });
  } else if (section === 'state') {
    // issue #351: state lives in local config
    writeLocalConfig(projectRoot, { state: value });
  } else if (section === 'hooks') {
    // issue #370/#372: hooks lives in local config (per-developer override)
    writeLocalConfig(projectRoot, { hooks: value });
  }
}

// ---------------------------------------------------------------------------
// normalizeBlankLines (private — issue #266)
// ---------------------------------------------------------------------------

/**
 * Normalize blank lines in an array of file lines (no trailing newline element).
 *
 * Rules:
 *   - Strip all leading blank lines (lines that are empty or whitespace-only).
 *   - Strip all trailing blank lines.
 *   - Collapse runs of consecutive blank lines to a single blank line.
 *
 * Used by both `ensureSdlcGitignore` and `ensureRootGitignore` so that
 * re-running setup never accumulates stray blank lines in the user-authored
 * portion of the file (issue #266). The function is kept private (not
 * exported) — only two callers, KISS.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function normalizeBlankLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const isBlank = (s) => s === '' || /^\s*$/.test(s);

  // Trim leading blanks
  let start = 0;
  while (start < lines.length && isBlank(lines[start])) start++;
  // Trim trailing blanks
  let end = lines.length - 1;
  while (end >= start && isBlank(lines[end])) end--;
  if (end < start) return [];

  // Collapse consecutive blank runs to one
  const out = [];
  let prevBlank = false;
  for (let i = start; i <= end; i++) {
    const blank = isBlank(lines[i]);
    if (blank) {
      if (prevBlank) continue;
      out.push('');
      prevBlank = true;
    } else {
      out.push(lines[i]);
      prevBlank = false;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ensureSdlcGitignore
// ---------------------------------------------------------------------------

// Deny-all + allowlist. Everything inside `.sdlc/` is ignored except:
// `.gitignore` (the file itself), `config.json`, and `review-dimensions/`.
// All other files and directories are ignored by default.
const SDLC_GITIGNORE_PATTERNS = [
  '*',
  '!.gitignore',
  '!config.json',
  '!review-dimensions/',
  '!review-dimensions/**',
];
const SDLC_GITIGNORE_BEGIN = '# >>> lift-sdlc managed (do not edit) — selective ignores';
const SDLC_GITIGNORE_END   = '# <<< lift-sdlc managed';

/**
 * Create `.sdlc/` directory and `.sdlc/.gitignore` with selective ignore
 * patterns (issue #231). Idempotent — re-running rewrites the managed block
 * in place rather than duplicating it.
 *
 * @param {string} projectRoot
 * @returns {'created'|'updated'|'unchanged'}
 */
function ensureSdlcGitignore(projectRoot) {
  const sdlcDir = path.join(projectRoot, '.sdlc');
  fs.mkdirSync(sdlcDir, { recursive: true });

  const gitignorePath = path.join(sdlcDir, '.gitignore');

  const managedBlock = [
    SDLC_GITIGNORE_BEGIN,
    ...SDLC_GITIGNORE_PATTERNS,
    SDLC_GITIGNORE_END,
  ].join('\n');

  // Step 1: Read existing file (empty string if absent).
  let existing = '';
  let fileExisted = false;
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf8');
    fileExisted = true;
  }

  // Step 2: Split into lines. Locate any existing managed block via markers;
  // extract it and remove it from the line list (leaving "other" lines).
  const lines = existing === '' ? [] : existing.split('\n');
  // Remove trailing empty string caused by a final newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const managedPatternSet = new Set(SDLC_GITIGNORE_PATTERNS);
  const otherLinesRaw = [];
  let insideBlock = false;
  for (const line of lines) {
    if (line === SDLC_GITIGNORE_BEGIN) {
      insideBlock = true;
      continue;
    }
    if (line === SDLC_GITIGNORE_END) {
      insideBlock = false;
      continue;
    }
    if (insideBlock) {
      // Drop lines that are part of the managed block.
      continue;
    }
    // Step 3: Drop any "other" lines whose trimmed value exactly matches a
    // member of SDLC-managed patterns (legacy raw pattern lines).
    if (managedPatternSet.has(line.trim())) {
      continue;
    }
    otherLinesRaw.push(line);
  }

  // Step 3b (issue #266): normalize blank lines in user-authored content so
  // re-runs are byte-identical. Without this, blank-line accumulation grows
  // by 2 lines per invocation in the worst case.
  const otherLines = normalizeBlankLines(otherLinesRaw);

  // Step 4: Reconstruct: leading user lines (if any) + single newline separator +
  // managed block + trailing newline. (Issue #273: use single '\n' between user
  // content and managed block so the writer is byte-identical to the committed
  // canonical shape — no spurious blank line.)
  let next;
  if (otherLines.length > 0) {
    next = otherLines.join('\n') + '\n' + managedBlock + '\n';
  } else {
    next = managedBlock + '\n';
  }

  // Step 5: Compare result to original; return status.
  if (next === existing) return 'unchanged';
  fs.writeFileSync(gitignorePath, next, 'utf8');
  return fileExisted ? 'updated' : 'created';
}

// ---------------------------------------------------------------------------
// ensureRootGitignore
// ---------------------------------------------------------------------------

// Patterns that the plugin manages in the consumer project root .gitignore.
// These are transient skill artifacts that scripts emit under `os.tmpdir()`;
// the gitignore block is defence-in-depth (issue #209) so a stray cwd-write
// from any future code path or shell redirect never lands in version control.
//
// .sdlc/ runtime files (local.json, cache/, .bak.*, .migration.lock) are now
// covered by .sdlc/.gitignore (deny-all + allowlist) and no longer need to be
// listed here.
//
// IMPORTANT: keep this list in sync with the prefixes used by `writeOutput`
// callers across the plugin (commit-context, pr-context, version-context,
// jira-context, review-manifest, received-review-manifest, sdlc-error-report,
// plan-prepare, ship-prepare, setup-prepare, etc.). The three glob families
// below cover all of them.
const ROOT_GITIGNORE_PATTERNS = [
  // Transient skill artifacts — defence-in-depth for prepare output files
  '*-context-*.json',
  '*-manifest-*.json',
  '*-prepare-*.json',
];

const ROOT_GITIGNORE_BEGIN = '# >>> lift-sdlc managed (do not edit) — transient skill artifacts';
const ROOT_GITIGNORE_END   = '# <<< lift-sdlc managed';

/**
 * Append (or update in place) a managed block to the consumer project root
 * `.gitignore`. The managed block ignores transient `*-context-*.json`,
 * `*-manifest-*.json`, and `*-prepare-*.json` artifacts (issue #209).
 *
 * Idempotent: detects the existing block by its marker comments and replaces
 * its contents in place. Never duplicates. Creates `.gitignore` if absent.
 * Existing user content is preserved (merge-style write, not overwrite).
 *
 * @param {string} projectRoot
 * @param {string[]} [extraPatterns=[]] Additional patterns to include in the
 *   managed block for this invocation only (issue #351 — used by the
 *   ensure-worktree-gitignore hook to add `.sdlc/worktrees/` without
 *   modifying ROOT_GITIGNORE_PATTERNS). Not persisted beyond this call.
 * @returns {'created'|'updated'|'unchanged'}
 */
function ensureRootGitignore(projectRoot, extraPatterns) {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const extraPats     = Array.isArray(extraPatterns) ? extraPatterns : [];

  const managedBlock = [
    ROOT_GITIGNORE_BEGIN,
    ...ROOT_GITIGNORE_PATTERNS,
    ...extraPats,
    ROOT_GITIGNORE_END,
  ].join('\n');

  let existing = '';
  let fileExisted = false;
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf8');
    fileExisted = true;
  }

  // Locate existing managed block for idempotent in-place replacement.
  const blockRegex = new RegExp(
    `${escapeRegExp(ROOT_GITIGNORE_BEGIN)}[\\s\\S]*?${escapeRegExp(ROOT_GITIGNORE_END)}`,
    'm'
  );

  let next;
  if (blockRegex.test(existing)) {
    next = existing.replace(blockRegex, managedBlock);
  } else if (existing.length === 0) {
    next = managedBlock + '\n';
  } else {
    // Append with a separating blank line if the file does not already end with one.
    const sep = existing.endsWith('\n\n') ? '' : (existing.endsWith('\n') ? '\n' : '\n\n');
    next = existing + sep + managedBlock + '\n';
  }

  // Issue #266: normalize blank lines so re-runs are byte-identical. Split the
  // result on the managed block, normalize the user-authored portion before
  // and after, then re-stitch with a single blank-line separator.
  next = normalizeAroundBlock(next, managedBlock);

  if (next === existing) return 'unchanged';

  fs.writeFileSync(gitignorePath, next, 'utf8');
  return fileExisted ? 'updated' : 'created';
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Issue #266: split a file content string on `managedBlock`, normalize blank
 * lines in the user-authored portions before/after the block, then re-stitch
 * so the file is byte-identical on a second invocation. Trailing newline
 * after the managed block is preserved.
 *
 * @param {string} content
 * @param {string} managedBlock
 * @returns {string}
 */
function normalizeAroundBlock(content, managedBlock) {
  const idx = content.indexOf(managedBlock);
  if (idx < 0) {
    // Block not present (unexpected); normalize whole content as user lines.
    const lines = content.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const normalized = normalizeBlankLines(lines);
    return normalized.length > 0 ? normalized.join('\n') + '\n' : '';
  }
  const beforeRaw = content.slice(0, idx);
  const afterRaw  = content.slice(idx + managedBlock.length);

  // Normalize "before" portion
  const beforeLines = beforeRaw.split('\n');
  // Drop trailing empty caused by '\n' immediately before block
  if (beforeLines.length > 0 && beforeLines[beforeLines.length - 1] === '') beforeLines.pop();
  const beforeNormalized = normalizeBlankLines(beforeLines);

  // Normalize "after" portion
  const afterLines = afterRaw.split('\n');
  // Strip leading empty caused by '\n' immediately after block
  if (afterLines.length > 0 && afterLines[0] === '') afterLines.shift();
  if (afterLines.length > 0 && afterLines[afterLines.length - 1] === '') afterLines.pop();
  const afterNormalized = normalizeBlankLines(afterLines);

  let result = '';
  if (beforeNormalized.length > 0) result += beforeNormalized.join('\n') + '\n\n';
  result += managedBlock + '\n';
  if (afterNormalized.length > 0) result += '\n' + afterNormalized.join('\n') + '\n';
  return result;
}

// ---------------------------------------------------------------------------
// ensureSdlcInfrastructure
// ---------------------------------------------------------------------------

/**
 * Composite helper: runs all idempotent layout reconciliation steps in one
 * call. Covers `.sdlc/.gitignore` (deny-all template) and root `.gitignore`
 * (transient artifact managed block). Called by prepare scripts and setup.
 *
 * @param {string} projectRoot
 * @returns {{ sdlcGitignore: string, rootGitignore: string }}
 */
function ensureSdlcInfrastructure(projectRoot) {
  return {
    sdlcGitignore: ensureSdlcGitignore(projectRoot),
    rootGitignore: ensureRootGitignore(projectRoot),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  resolveSdlcRoot,
  readProjectConfig,
  readLocalConfig,
  readSection,
  writeProjectConfig,
  writeLocalConfig,
  writeSection,
  computeConfigDiff,
  ensureSdlcGitignore,
  ensureRootGitignore,
  ensureSdlcInfrastructure,
  PRESET_NAMES,
  PRESET_TO_STEPS,
  // Exposed for testing
  PROJECT_CONFIG_PATH,
  LOCAL_CONFIG_PATH,
  PROJECT_SCHEMA_URL,
  LOCAL_SCHEMA_URL,
  PROJECT_SECTIONS,
};
