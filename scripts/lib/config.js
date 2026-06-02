'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { CURRENT_SCHEMA_VERSION } = require('./config-version.js');
const {
  PRESET_TO_STEPS: _MIGRATIONS_PRESET_MAP,
} = require('./config-migrations.js');
const { resolveMainWorktreeSafe } = require('./worktree');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Issue #231: project config now lives at .sdlc/config.json. The legacy
// path is read transparently as a one-time fallback (with stderr deprecation
// notice) for two minor versions; writes always target the new path.
const PROJECT_CONFIG_PATH = path.join('.sdlc', 'config.json');
const LEGACY_PROJECT_CONFIG_PATH = path.join('.antigravity', 'antigravity.json');
const LOCAL_CONFIG_PATH = path.join('.sdlc', 'local.json');

// Per-process flag: emit the legacy-path deprecation warning at most once.
let _legacyProjectWarningEmitted = false;
function emitLegacyProjectWarningOnce() {
  if (_legacyProjectWarningEmitted) return;
  _legacyProjectWarningEmitted = true;
  process.stderr.write(
    `Deprecation: ${LEGACY_PROJECT_CONFIG_PATH} is the legacy project-config path. ` +
    `Run /setup-sdlc --migrate to relocate to ${PROJECT_CONFIG_PATH}.\n`
  );
}

const PROJECT_SCHEMA_URL =
  'https://raw.githubusercontent.com/rnagrodzki/sdlc-marketplace/main/schemas/sdlc-config.schema.json';
const LOCAL_SCHEMA_URL =
  'https://raw.githubusercontent.com/rnagrodzki/sdlc-marketplace/main/schemas/sdlc-local.schema.json';

const PRESET_NAMES = ['full', 'balanced', 'minimal'];
const LEGACY_PRESET_MAP = { A: 'full', B: 'balanced', C: 'minimal' };

// Issue #232: schemaVersion is the unified version field. The legacy
// LOCAL_SCHEMA_VERSION constant is preserved as an alias of
// CURRENT_SCHEMA_VERSION for callers that still import it.
const LOCAL_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

// PRESET_TO_STEPS is now owned by lib/config-migrations.js. Re-export
// from there to keep external callers (lib/ship-fields.js) working.
const PRESET_TO_STEPS = _MIGRATIONS_PRESET_MAP;

/**
 * Normalize a preset value: maps legacy A/B/C to full/balanced/minimal.
 * Unknown values pass through unchanged (validation catches them later).
 * @param {string|undefined} value
 * @returns {string|undefined}
 */
function normalizePreset(value) {
  if (typeof value !== 'string') return value;
  return LEGACY_PRESET_MAP[value.toUpperCase()] || value;
}

/** Legacy file paths relative to projectRoot. */
const LEGACY = {
  version: path.join('.antigravity', 'version.json'),
  ship: path.join('.antigravity', 'ship-config.json'),
  jira: path.join('.antigravity', 'jira-config.json'),
  reviewSdlc: path.join('.antigravity', 'review.json'),
  reviewAntigravity: path.join('.antigravity', 'review.json'),
};

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
 * Read the unified project config.
 * Reads `.sdlc/config.json` first (issue #231 — new canonical location).
 * Falls back to legacy `.sdlc/sdlc.json` with a one-time stderr deprecation
 * notice. As a last resort, merges individual legacy per-file configs
 * (`.sdlc/version.json`, etc).
 *
 * @param {string} projectRoot
 * @returns {{ config: object|null, sources: string[] }}
 */
function readProjectConfig(projectRoot) {
  // 1. New canonical path
  const newPath = path.join(projectRoot, PROJECT_CONFIG_PATH);
  const unifiedNew = readJsonFile(newPath);
  if (unifiedNew) {
    _traceRead(path.resolve(newPath), 'read');
    return { config: unifiedNew, sources: [PROJECT_CONFIG_PATH] };
  }
  _traceRead(path.resolve(newPath), 'read-miss');

  // 2. Legacy fallback — merge individual config files
  const sources = [];
  const config = {};

  // version (.sdlc/version.json)
  const versionPath = path.join(projectRoot, LEGACY.version);
  const versionData = readJsonFile(versionPath);
  if (versionData) {
    process.stderr.write(
      `Deprecation: ${LEGACY.version} detected. Run /setup-sdlc --migrate to consolidate into ${PROJECT_CONFIG_PATH}.\n`
    );
    config.version = stripMeta(versionData, '$schema');
    sources.push(LEGACY.version);
  }

  // jira (.sdlc/jira-config.json)
  const jiraPath = path.join(projectRoot, LEGACY.jira);
  const jiraData = readJsonFile(jiraPath);
  if (jiraData) {
    process.stderr.write(
      `Deprecation: ${LEGACY.jira} detected. Run /setup-sdlc --migrate to consolidate into ${PROJECT_CONFIG_PATH}.\n`
    );
    config.jira = stripMeta(jiraData, '$schema');
    sources.push(LEGACY.jira);
  }

  if (sources.length === 0) return { config: null, sources: [] };
  return { config, sources };
}

// ---------------------------------------------------------------------------
// readLocalConfig
// ---------------------------------------------------------------------------

/**
 * Read the local (gitignored) config (.sdlc/local.json).
 * Falls back to .sdlc/review.json, then .sdlc/review.json.
 *
 * @param {string} projectRoot
 * @returns {{ config: object|null, sources: string[] }}
 */
function readLocalConfig(projectRoot) {
  const localPath = path.join(projectRoot, LOCAL_CONFIG_PATH);
  const localData = readJsonFile(localPath);

  // Trace the read (issue #351): emits one [sdlc:config] line per unique abs path.
  _traceRead(path.resolve(localPath), localData ? 'read' : 'read-miss');

  // Issue #232: schema-version migration is no longer performed here. It is
  // owned by lib/config-version.js::verifyAndMigrate, called from each
  // skill's prepare script (and from ship-sdlc at pipeline entry). By the
  // time this function is invoked, the file is at CURRENT_SCHEMA_VERSION
  // (or the prepare script halted before now). Reading is pure I/O.

  // If local.json exists and has both review and ship, no fallbacks needed
  if (localData && localData.review && localData.ship) {
    return { config: localData, sources: [LOCAL_CONFIG_PATH] };
  }

  const sources = localData ? [LOCAL_CONFIG_PATH] : [];
  const config = localData ? { ...localData } : {};

  // Review fallback (only if review is missing from config)
  if (!config.review) {
    const sdlcReviewPath = path.join(projectRoot, LEGACY.reviewSdlc);
    const sdlcReview = readJsonFile(sdlcReviewPath);
    if (sdlcReview) {
      process.stderr.write(
        `Deprecation: ${LEGACY.reviewSdlc} detected. Run /setup-sdlc --migrate to consolidate into .sdlc/local.json.\n`
      );
      config.review = sdlcReview.defaults ? { ...sdlcReview.defaults } : stripMeta(sdlcReview, '$schema');
      sources.push(LEGACY.reviewSdlc);
    } else {
      const antigravityReviewPath = path.join(projectRoot, LEGACY.reviewAntigravity);
      const antigravityReview = readJsonFile(antigravityReviewPath);
      if (antigravityReview) {
        process.stderr.write(
          `Deprecation: ${LEGACY.reviewAntigravity} detected. Run /setup-sdlc --migrate to consolidate into .sdlc/local.json.\n`
        );
        config.review = antigravityReview.defaults ? { ...antigravityReview.defaults } : stripMeta(antigravityReview, '$schema');
        sources.push(LEGACY.reviewAntigravity);
      }
    }
  }

  // Ship fallback (only if ship is missing from config)
  if (!config.ship) {
    // Legacy .sdlc/ship-config.json
    const shipPath = path.join(projectRoot, LEGACY.ship);
    const shipData = readJsonFile(shipPath);
    if (shipData) {
      process.stderr.write(
        `Deprecation: ${LEGACY.ship} detected. Run /setup-sdlc --migrate to consolidate into .sdlc/local.json.\n`
      );
      config.ship = stripMeta(shipData, '$schema', 'version');
      sources.push(LEGACY.ship);
    } else {
      // Fallback to project-config ship key (read new path first, legacy second).
      const projectConfigNew = path.join(projectRoot, PROJECT_CONFIG_PATH);
      const projectDataNew = readJsonFile(projectConfigNew);
      if (projectDataNew?.ship) {
        process.stderr.write(
          `Deprecation: ship section found in ${PROJECT_CONFIG_PATH}. Run /setup-sdlc --migrate to move it to .sdlc/local.json.\n`
        );
        config.ship = projectDataNew.ship;
        sources.push(PROJECT_CONFIG_PATH);
      }
    }
  }

  if (sources.length === 0) return { config: null, sources: [] };
  return { config, sources };
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
// consolidateLegacyFiles (renamed from migrateConfig — issue #231/#232)
// ---------------------------------------------------------------------------

/**
 * Read all legacy *file-layout* configs (per-section files like
 * `.sdlc/version.json`, `.sdlc/ship-config.json`), merge their content
 * into the unified `.sdlc/config.json` and `.sdlc/local.json`, and write
 * them. Does NOT delete legacy files — the caller decides.
 *
 * **Renamed from `migrateConfig`** (issue #231) to disambiguate from the
 * schema-version migration owned by `lib/config-version.js::verifyAndMigrate`:
 *   - `consolidateLegacyFiles` runs once during setup; it reshapes file
 *     layout (multi-file → unified).
 *   - `verifyAndMigrate` runs every skill invocation; it walks the schema
 *     migration registry (v0→v3 etc.) on the unified files.
 *
 * Schema-version migration (e.g. v1→v2 ship preset/skip → steps[]) is no
 * longer performed inline here — it is deferred to `verifyAndMigrate`,
 * which the caller invokes after this function completes.
 *
 * @param {string} projectRoot
 * @returns {{ migrated: string[], conflicts: string[] }}
 */
function consolidateLegacyFiles(projectRoot) {
  const migrated = [];
  const conflicts = [];

  // --- Project config ---
  const projectConfig = {};
  const unifiedPath = path.join(projectRoot, PROJECT_CONFIG_PATH);
  // For ship-section consolidation we also need to look at the legacy
  // unified path (.sdlc/sdlc.json) when the new path is empty — this
  // function may run before verifyAndMigrate has relocated it.
  // Runs before migration — legacy file may still exist here
  const existingUnified = readJsonFile(unifiedPath)
    || readJsonFile(path.join(projectRoot, LEGACY_PROJECT_CONFIG_PATH));

  // version
  const versionPath = path.join(projectRoot, LEGACY.version);
  const versionData = readJsonFile(versionPath);
  if (versionData) {
    const section = stripMeta(versionData, '$schema');
    if (existingUnified?.version) {
      conflicts.push(LEGACY.version);
    } else {
      projectConfig.version = section;
      migrated.push(LEGACY.version);
    }
  }

  // jira
  const jiraPath = path.join(projectRoot, LEGACY.jira);
  const jiraData = readJsonFile(jiraPath);
  if (jiraData) {
    const section = stripMeta(jiraData, '$schema');
    if (existingUnified?.jira) {
      conflicts.push(LEGACY.jira);
    } else {
      projectConfig.jira = section;
      migrated.push(LEGACY.jira);
    }
  }

  if (Object.keys(projectConfig).length > 0) {
    writeProjectConfig(projectRoot, projectConfig);
  }

  // --- Local config ---
  const localPath = path.join(projectRoot, LOCAL_CONFIG_PATH);
  const existingLocal = readJsonFile(localPath);

  // review — prefer .sdlc/review.json over .sdlc/review.json
  let reviewSource = null;
  let reviewData = null;

  const sdlcReviewPath = path.join(projectRoot, LEGACY.reviewSdlc);
  const sdlcReview = readJsonFile(sdlcReviewPath);
  if (sdlcReview) {
    reviewSource = LEGACY.reviewSdlc;
    reviewData = sdlcReview;
  } else {
    const antigravityReviewPath = path.join(projectRoot, LEGACY.reviewAntigravity);
    const antigravityReview = readJsonFile(antigravityReviewPath);
    if (antigravityReview) {
      reviewSource = LEGACY.reviewAntigravity;
      reviewData = antigravityReview;
    }
  }

  if (reviewData && reviewSource) {
    const review = reviewData.defaults ? { ...reviewData.defaults } : stripMeta(reviewData, '$schema');
    if (existingLocal?.review) {
      conflicts.push(reviewSource);
    } else {
      writeLocalConfig(projectRoot, { review });
      migrated.push(reviewSource);
    }
  }

  // ship — legacy .sdlc/ship-config.json → .sdlc/local.json
  // Schema-version migration (v1→v2 preset/skip → steps[]) is deferred to
  // verifyAndMigrate which the caller (migrate-config.js) invokes after.
  let shipMigrated = false;
  const shipPath = path.join(projectRoot, LEGACY.ship);
  const shipData = readJsonFile(shipPath);
  if (shipData) {
    const section = stripMeta(shipData, '$schema', 'version');
    if (existingLocal?.ship) {
      conflicts.push(LEGACY.ship);
    } else {
      writeLocalConfig(projectRoot, { ship: section });
      migrated.push(LEGACY.ship);
      shipMigrated = true;
    }
  }

  // ship — legacy project-config ship key → .sdlc/local.json.
  // existingUnified may have been read from the new path or the legacy
  // path; we only strip ship from the new-path file (the legacy file is
  // left untouched — verifyAndMigrate's relocation step copies it as-is
  // and a subsequent ship-stripping write happens through writeProjectConfig).
  if (existingUnified?.ship) {
    const localHasShip = existingLocal?.ship || shipMigrated;
    if (localHasShip) {
      conflicts.push(PROJECT_CONFIG_PATH + '#ship');
    } else {
      writeLocalConfig(projectRoot, { ship: existingUnified.ship });
      migrated.push(PROJECT_CONFIG_PATH + '#ship');
    }
    // Strip ship from the new-path project config if it exists. If only
    // the legacy file has it, leave it alone — relocation will copy the
    // ship-included content over and a subsequent setup pass can re-strip.
    if (fs.existsSync(unifiedPath)) {
      const onDisk = readJsonFile(unifiedPath);
      if (onDisk?.ship) {
        const { ship: _removed, ...rest } = onDisk;
        writeJsonFile(unifiedPath, { ...rest, $schema: PROJECT_SCHEMA_URL });
      }
    }
  }

  return { migrated, conflicts };
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
const SDLC_GITIGNORE_BEGIN = '# >>> sdlc-utilities managed (do not edit) — selective ignores';
const SDLC_GITIGNORE_END   = '# <<< sdlc-utilities managed';

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
// ensureReviewDimensionsRelocated
// ---------------------------------------------------------------------------

/**
 * Idempotent one-time copy: if `.sdlc/review-dimensions/` exists AND
 * `.sdlc/review-dimensions/` is absent/empty, copy all files from the legacy
 * location to the new one. The legacy directory is NOT deleted here (cleanup is
 * handled by cleanupLegacyAntigravityFiles (R-layout-9)). Skip-if-exists semantics:
 * individual files already in `.sdlc/review-dimensions/` are not overwritten.
 *
 * @param {string} projectRoot
 * @returns {'created'|'noop'}
 */
function ensureReviewDimensionsRelocated(projectRoot) {
  const legacyDir = path.join(projectRoot, '.antigravity', 'review-dimensions');
  const newDir    = path.join(projectRoot, '.sdlc',   'review-dimensions');

  if (!fs.existsSync(legacyDir)) return 'noop';

  fs.mkdirSync(newDir, { recursive: true });

  // Copy files from legacy → new with skip-if-exists semantics.
  let copied = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(legacyDir, { withFileTypes: true });
  } catch (_) {
    return 'noop';
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const src  = path.join(legacyDir, entry.name);
    const dest = path.join(newDir,    entry.name);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      copied++;
    }
  }
  return copied > 0 ? 'created' : 'noop';
}

// ---------------------------------------------------------------------------
// cleanupLegacyAntigravityFiles (R-layout-9)
// ---------------------------------------------------------------------------

/**
 * Remove legacy `.sdlc/` SDLC files that have already been relocated to
 * `.sdlc/`. Each deletion is gated on the new target being present and
 * non-empty, so the cleanup is safe to run after relocation steps.
 *
 * Removes:
 *   - `.sdlc/sdlc.json`         — gated on `.sdlc/config.json` existing and non-empty
 *   - `.sdlc/sdlc.json.bak`     — same gate
 *   - `.sdlc/review-dimensions/`— gated on `.sdlc/review-dimensions/` being non-empty
 *
 * Implements R-layout-9.
 *
 * @param {string} projectRoot
 * @returns {{ removed: string[] }}
 */
function cleanupLegacyAntigravityFiles(projectRoot) {
  const removed = [];
  const antigravityJson    = path.join(projectRoot, '.antigravity', 'antigravity.json');
  const antigravityBak     = path.join(projectRoot, '.antigravity', 'antigravity.json.bak');
  const antigravityRevDir  = path.join(projectRoot, '.antigravity', 'review-dimensions');
  const sdlcJson      = path.join(projectRoot, '.sdlc', 'config.json');
  const sdlcRevDir    = path.join(projectRoot, '.sdlc', 'review-dimensions');

  // Gate: only delete legacy when new target is present and non-empty.
  const sdlcJsonOk = fs.existsSync(sdlcJson) && fs.statSync(sdlcJson).size > 0;
  const sdlcRevOk  = fs.existsSync(sdlcRevDir) && fs.readdirSync(sdlcRevDir).length > 0;

  if (sdlcJsonOk) {
    if (fs.existsSync(antigravityJson)) { fs.unlinkSync(antigravityJson); removed.push('.sdlc/sdlc.json'); }
    if (fs.existsSync(antigravityBak))  { fs.unlinkSync(antigravityBak);  removed.push('.sdlc/sdlc.json.bak'); }
  }
  if (sdlcRevOk && fs.existsSync(antigravityRevDir)) {
    fs.rmSync(antigravityRevDir, { recursive: true, force: true });
    removed.push('.antigravity/review-dimensions/');
  }
  return { removed };
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

// Bump the managed-block version marker to v3. The .sdlc/ runtime patterns
// are now handled by .sdlc/.gitignore (deny-all + allowlist), so the root
// block only needs the three transient-artifact globs.
const ROOT_GITIGNORE_BEGIN    = '# >>> sdlc-utilities managed v3 (do not edit) — transient skill artifacts';
const ROOT_GITIGNORE_END      = '# <<< sdlc-utilities managed';
// Legacy v2 marker (used for in-place replacement of v2 blocks).
const ROOT_GITIGNORE_BEGIN_V2 = '# >>> sdlc-utilities managed v2 (do not edit) — transient skill artifacts and .sdlc/ runtime';
// Legacy v1 marker (used for in-place replacement of older blocks).
const ROOT_GITIGNORE_BEGIN_V1 = '# >>> sdlc-utilities managed (do not edit) — transient skill artifacts';

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

  // Look for an existing managed block. Cascade: v3 → v2 → v1 so existing
  // installations are upgraded in place.
  const blockRegexV3 = new RegExp(
    `${escapeRegExp(ROOT_GITIGNORE_BEGIN)}[\\s\\S]*?${escapeRegExp(ROOT_GITIGNORE_END)}`,
    'm'
  );
  const blockRegexV2 = new RegExp(
    `${escapeRegExp(ROOT_GITIGNORE_BEGIN_V2)}[\\s\\S]*?${escapeRegExp(ROOT_GITIGNORE_END)}`,
    'm'
  );
  const blockRegexV1 = new RegExp(
    `${escapeRegExp(ROOT_GITIGNORE_BEGIN_V1)}[\\s\\S]*?${escapeRegExp(ROOT_GITIGNORE_END)}`,
    'm'
  );

  let next;
  if (blockRegexV3.test(existing)) {
    next = existing.replace(blockRegexV3, managedBlock);
  } else if (blockRegexV2.test(existing)) {
    // Upgrade v2 → v3 in place.
    next = existing.replace(blockRegexV2, managedBlock);
  } else if (blockRegexV1.test(existing)) {
    // Upgrade v1 → v3 in place.
    next = existing.replace(blockRegexV1, managedBlock);
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
 * call. Covers `.sdlc/.gitignore` (deny-all template), root `.gitignore`
 * (transient artifact managed block), and review-dimensions relocation.
 * Called by prepare scripts and migrate-config regardless of skip flag.
 *
 * @param {string} projectRoot
 * @returns {{ sdlcGitignore: string, rootGitignore: string, reviewDimensions: string }}
 */
function ensureSdlcInfrastructure(projectRoot) {
  const reviewDimensions = ensureReviewDimensionsRelocated(projectRoot);
  const legacyCleanup    = cleanupLegacyAntigravityFiles(projectRoot);
  return {
    sdlcGitignore:    ensureSdlcGitignore(projectRoot),
    rootGitignore:    ensureRootGitignore(projectRoot),
    reviewDimensions,
    legacyCleanup,
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
  consolidateLegacyFiles,
  // Backward-compat alias — renamed in issue #231; remove in 0.21.x.
  migrateConfig: consolidateLegacyFiles,
  ensureSdlcGitignore,
  ensureReviewDimensionsRelocated,
  cleanupLegacyAntigravityFiles,
  ensureRootGitignore,
  ensureSdlcInfrastructure,
  // Preset normalization
  normalizePreset,
  PRESET_NAMES,
  // PRESET_TO_STEPS re-exported from config-migrations.js for callers.
  PRESET_TO_STEPS,
  LOCAL_SCHEMA_VERSION,
  // Exposed for testing
  PROJECT_CONFIG_PATH,
  LEGACY_PROJECT_CONFIG_PATH,
  LOCAL_CONFIG_PATH,
  LEGACY,
  PROJECT_SCHEMA_URL,
  LOCAL_SCHEMA_URL,
  PROJECT_SECTIONS,
};
