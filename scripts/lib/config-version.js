'use strict';

// ---------------------------------------------------------------------------
// config-version.js — schema-version contract for SDLC config files.
//
// Single entry point: verifyAndMigrate(projectRoot, role, opts)
//   - role ∈ {'project', 'local'}
//   - reads the config file via lib/config.js, determines its current
//     schemaVersion, walks the migration registry from
//     lib/config-migrations.js to bring the file to CURRENT_SCHEMA_VERSION,
//     stamps the version, atomically rewrites the file, and returns a
//     manifest of what happened.
//
// Concurrency: a coarse `.sdlc/.migration.lock` (O_EXCL atomic create with
// PID + retry-with-backoff) prevents two parallel skills from migrating the
// same file at the same time.
//
// Backups: each file is backed up before any in-place migration runs. The
// one-time legacy relocation step (project v0→v3) writes its backup to
// `.sdlc/sdlc.json.bak` inside the consumer project's SDLC surface (no timestamp
// suffix — single one-time backup, issue #231 acceptance). All other in-place
// backups go to `.sdlc/<file>.bak.<filesystem-safe-ISO>` where the timestamp
// uses `T` and `-` separators (no `:`).
//
// Implements issue #232 (schema versioning) and the migration glue half of
// issue #231 (legacy relocation).
// ---------------------------------------------------------------------------

const fs   = require('fs');
const path = require('path');

const CURRENT_SCHEMA_VERSION = 4;

const LOCK_RELATIVE_PATH = path.join('.sdlc', '.migration.lock');
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_MAX_RETRIES = 30;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

class ConfigVersionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

class ConfigVersionTooNewError extends ConfigVersionError {
  constructor(role, found, max, pluginVersion) {
    super(
      `Config ${role} schemaVersion=${found} exceeds max supported version ${max} ` +
      `(plugin ${pluginVersion}). Upgrade the sdlc-utilities plugin.`,
      'CONFIG_VERSION_TOO_NEW'
    );
    this.role = role;
    this.found = found;
    this.max = max;
    this.pluginVersion = pluginVersion;
  }
}

class ConfigMigrationError extends ConfigVersionError {
  constructor(role, stepLabel, cause) {
    super(
      `Config migration failed for ${role} at step "${stepLabel}": ${cause?.message || cause}`,
      'CONFIG_MIGRATION_FAILED'
    );
    this.role = role;
    this.step = stepLabel;
    this.cause = cause;
  }
}

class ConfigMigrationLocked extends ConfigVersionError {
  constructor(lockPath, holderPid) {
    super(
      `Config migration lock held by PID ${holderPid} at ${lockPath}. ` +
      `If this is stale, remove the lock file and retry.`,
      'CONFIG_MIGRATION_LOCKED'
    );
    this.lockPath = lockPath;
    this.holderPid = holderPid;
  }
}

// ---------------------------------------------------------------------------
// Plugin version (best-effort; absence is non-fatal)
// ---------------------------------------------------------------------------

function getPluginVersion() {
  try {
    // The plugin's plugin.json is two directories above this file:
    // scripts/lib/config-version.js → plugins/<plugin>/plugin.json
    const pkgPath = path.resolve(__dirname, '..', '..', 'plugin.json');
    if (fs.existsSync(pkgPath)) {
      const data = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return data.version || 'unknown';
    }
  } catch (_) {
    // Fall through.
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Filesystem-safe ISO timestamp (no colons; T and - separators)
// e.g. 2026-05-06T08-04-32Z
// ---------------------------------------------------------------------------

function fsSafeIsoTimestamp(d = new Date()) {
  return d.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Lock helpers
// ---------------------------------------------------------------------------

function sleepSyncMs(ms) {
  // Synchronous sleep via Atomics on a SharedArrayBuffer. Node provides
  // Atomics.wait synchronously on a shared int32 array.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function acquireLock(projectRoot) {
  const sdlcDir = path.join(projectRoot, '.sdlc');
  if (!fs.existsSync(sdlcDir)) {
    fs.mkdirSync(sdlcDir, { recursive: true });
  }
  const lockPath = path.join(projectRoot, LOCK_RELATIVE_PATH);
  const pid = String(process.pid);

  for (let attempt = 0; attempt <= LOCK_MAX_RETRIES; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx'); // O_EXCL atomic create
      try {
        fs.writeSync(fd, pid);
      } finally {
        fs.closeSync(fd);
      }
      return lockPath;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (attempt === LOCK_MAX_RETRIES) {
        // Read holder PID for the error message (best-effort).
        let holderPid = 'unknown';
        try {
          holderPid = fs.readFileSync(lockPath, 'utf8').trim() || 'unknown';
        } catch (_) { /* ignore */ }
        throw new ConfigMigrationLocked(lockPath, holderPid);
      }
      sleepSyncMs(LOCK_RETRY_DELAY_MS);
    }
  }
  // Unreachable.
  return lockPath;
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch (_) {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// JSON I/O helpers (intentionally tiny — full helpers live in lib/config.js)
// ---------------------------------------------------------------------------

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigMigrationError(
      'unknown',
      `parse(${filePath})`,
      new Error(`Invalid JSON in "${filePath}": ${err.message}`)
    );
  }
}

function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write via .tmp sibling then rename.
  const tmp = filePath + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Backup helpers
// ---------------------------------------------------------------------------

/**
 * Write a backup of `srcPath` to `backupPath`. Returns the backup path or
 * null if the source did not exist.
 */
function writeBackup(srcPath, backupPath) {
  if (!fs.existsSync(srcPath)) return null;
  const dir = path.dirname(backupPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(srcPath, backupPath);
  return backupPath;
}

// ---------------------------------------------------------------------------
// Path resolution per role
// ---------------------------------------------------------------------------

/**
 * Returns the canonical (post-migration) on-disk path for a role's config.
 *
 * NOTE: this intentionally hardcodes the new `.sdlc/` path. Once T6 lands,
 * `lib/config.js` will export `PROJECT_CONFIG_PATH = .sdlc/config.json`. We
 * cannot import that constant here without creating a circular dependency
 * during T6, so the path is duplicated. Both must stay in sync — if you
 * change one, change the other (covered by exec test).
 */
function resolveConfigPaths(projectRoot, role) {
  if (role === 'project') {
    return {
      newPath: path.join(projectRoot, '.sdlc', 'config.json'),
      legacyPath: path.join(projectRoot, '.sdlc', 'sdlc.json'),
      defaultMissingVersion: 0, // missing field on a project file → 0
    };
  }
  if (role === 'local') {
    return {
      newPath: path.join(projectRoot, '.sdlc', 'local.json'),
      legacyPath: null,
      defaultMissingVersion: 1, // missing field on a local file → 1
    };
  }
  throw new Error(`Unknown role: ${role}`);
}

// ---------------------------------------------------------------------------
// Determine the current on-disk schemaVersion for a role.
//
// Priority for `project`:
//   1. .sdlc/config.json with `schemaVersion` field → use that
//   2. .sdlc/config.json without `schemaVersion` → 0 (treat as pre-version)
//   3. .sdlc/sdlc.json (legacy, no `.sdlc/config.json`) → 0
//   4. neither file exists → null (no config; nothing to migrate)
//
// Priority for `local`:
//   1. .sdlc/local.json with `schemaVersion` field → use that
//   2. .sdlc/local.json with legacy `version` integer → that value
//   3. .sdlc/local.json without either → 1 (matches historical pre-versioned)
//   4. file does not exist → null
// ---------------------------------------------------------------------------

function detectCurrentVersion(role, paths) {
  if (role === 'project') {
    if (fs.existsSync(paths.newPath)) {
      const data = readJsonFile(paths.newPath);
      if (typeof data?.schemaVersion === 'number') return { version: data.schemaVersion, source: 'new' };
      return { version: 0, source: 'new' };
    }
    if (paths.legacyPath && fs.existsSync(paths.legacyPath)) {
      // Legacy file with no schemaVersion field — pre-version era.
      return { version: 0, source: 'legacy' };
    }
    return { version: null, source: null };
  }
  if (role === 'local') {
    if (!fs.existsSync(paths.newPath)) return { version: null, source: null };
    const data = readJsonFile(paths.newPath);
    if (typeof data?.schemaVersion === 'number') return { version: data.schemaVersion, source: 'new' };
    if (typeof data?.version === 'number') return { version: data.version, source: 'new' };
    return { version: 1, source: 'new' };
  }
  throw new Error(`Unknown role: ${role}`);
}

// ---------------------------------------------------------------------------
// Walk the migration registry from `from` to `to`, applying each step.
// Each step is `{ from, to, run, rollback? }`. `run(ctx)` mutates files on
// disk and returns the new in-memory data shape; `rollback(ctx)` is invoked
// in reverse order on failure.
// ---------------------------------------------------------------------------

function planMigrationSteps(registry, fromVersion, toVersion) {
  // Naive linear walk: registry must be ordered such that each step's `from`
  // matches the cumulative `to` of the previous step. Two registry shapes
  // are accepted:
  //   - linear chain of single-step migrations (e.g. local: v1→v2, v2→v3)
  //   - single-jump migrations (e.g. project: v0→v3)
  // The walker picks whichever step's `from` matches the cursor and whose
  // `to <= toVersion`.
  const steps = [];
  let cursor = fromVersion;
  const visited = new Set();
  while (cursor < toVersion) {
    const candidate = registry.find(s => s.from === cursor && s.to <= toVersion);
    if (!candidate) {
      throw new ConfigMigrationError(
        'unknown',
        `plan(from=${cursor}, to=${toVersion})`,
        new Error(`No migration step found from v${cursor} toward v${toVersion}`)
      );
    }
    const key = `${candidate.from}->${candidate.to}`;
    if (visited.has(key)) {
      throw new ConfigMigrationError(
        'unknown',
        'plan',
        new Error(`Cycle detected at step ${key}`)
      );
    }
    visited.add(key);
    steps.push(candidate);
    cursor = candidate.to;
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Public API: verifyAndMigrate
// ---------------------------------------------------------------------------

/**
 * Verify a config file is at the current schema version, migrating as needed.
 *
 * @param {string} projectRoot
 * @param {string} role — 'project' | 'local'
 * @param {object} [opts]
 * @param {string} [opts.dryRun] — if true, do not acquire the lock or write
 *   files. Returns a manifest describing what would happen.
 * @returns {{ schemaVersion: number, migrated: boolean, backupPath: string|null, stepsApplied: string[] }}
 *
 * Throws:
 *   - ConfigVersionTooNewError when the on-disk version exceeds CURRENT_SCHEMA_VERSION
 *   - ConfigMigrationError when a step fails (after rollback)
 *   - ConfigMigrationLocked when the lock cannot be acquired
 */
function verifyAndMigrate(projectRoot, role, opts = {}) {
  const { PROJECT_MIGRATIONS, LOCAL_MIGRATIONS } = require('./config-migrations.js');
  const registry = role === 'project' ? PROJECT_MIGRATIONS : LOCAL_MIGRATIONS;
  const paths = resolveConfigPaths(projectRoot, role);

  const detected = detectCurrentVersion(role, paths);

  // No file at all → nothing to do.
  if (detected.version === null) {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      migrated: false,
      backupPath: null,
      stepsApplied: [],
    };
  }

  // File at current version → no-op.
  if (detected.version === CURRENT_SCHEMA_VERSION) {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      migrated: false,
      backupPath: null,
      stepsApplied: [],
    };
  }

  // Future version → refuse.
  if (detected.version > CURRENT_SCHEMA_VERSION) {
    throw new ConfigVersionTooNewError(
      role,
      detected.version,
      CURRENT_SCHEMA_VERSION,
      getPluginVersion()
    );
  }

  // Plan the steps.
  const steps = planMigrationSteps(registry, detected.version, CURRENT_SCHEMA_VERSION);

  if (opts.dryRun) {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      migrated: false,
      backupPath: null,
      stepsApplied: steps.map(s => `${role}: v${s.from}→v${s.to}`),
      dryRun: true,
    };
  }

  // Acquire lock for the actual migration.
  const lockPath = acquireLock(projectRoot);
  let backupPath = null;
  const appliedLabels = [];
  const appliedSteps = [];

  try {
    // Backup before any mutation.
    backupPath = computeBackupPath(projectRoot, role, paths, detected);
    if (backupPath) {
      const sourceForBackup = detected.source === 'legacy' ? paths.legacyPath : paths.newPath;
      writeBackup(sourceForBackup, backupPath);
    }

    // Apply each step in order.
    const ctx = {
      projectRoot,
      role,
      paths,
      readJsonFile,
      writeJsonFile,
    };

    for (const step of steps) {
      const label = `${role}: v${step.from}→v${step.to} (${step.run.name || 'anonymous'})`;
      try {
        step.run(ctx);
        appliedLabels.push(label);
        appliedSteps.push(step);
      } catch (err) {
        // Roll back applied steps in reverse order.
        for (let i = appliedSteps.length - 1; i >= 0; i--) {
          const rollbackStep = appliedSteps[i];
          if (typeof rollbackStep.rollback === 'function') {
            try { rollbackStep.rollback(ctx); } catch (_) { /* best-effort */ }
          }
        }
        // Default cleanup for unrolled steps: delete the new file if a
        // backup exists at the legacy location.
        throw new ConfigMigrationError(role, label, err);
      }
    }

    // Stamp final schemaVersion on the new file.
    const finalData = readJsonFile(paths.newPath) || {};
    finalData.schemaVersion = CURRENT_SCHEMA_VERSION;
    writeJsonFile(paths.newPath, finalData);

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      migrated: true,
      backupPath,
      stepsApplied: appliedLabels,
    };
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Compute the backup path for a given role + detected source. Returns null
 * when the source file does not exist (nothing to back up).
 */
function computeBackupPath(projectRoot, role, paths, detected) {
  if (role === 'project' && detected.source === 'legacy') {
    // Backup of legacy `.antigravity/antigravity.json` lands inside `.sdlc/` (consumer
    // project's SDLC surface), not `.antigravity/` (Antigravity Code's surface).
    // Single one-time backup, no timestamp suffix.
    return path.join(projectRoot, '.sdlc', path.basename(paths.legacyPath) + '.bak');
  }
  // All other in-place migrations: .sdlc/<file>.bak.<safe-iso>
  const ts = fsSafeIsoTimestamp();
  return paths.newPath + '.bak.' + ts;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  CURRENT_SCHEMA_VERSION,
  verifyAndMigrate,
  ConfigVersionError,
  ConfigVersionTooNewError,
  ConfigMigrationError,
  ConfigMigrationLocked,
  // Exposed for tests
  resolveConfigPaths,
  detectCurrentVersion,
  fsSafeIsoTimestamp,
  getPluginVersion,
};
