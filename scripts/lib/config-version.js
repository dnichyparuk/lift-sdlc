'use strict';

// ---------------------------------------------------------------------------
// config-version.js — schema-version contract for SDLC config files.
//
// Single entry point: verifyAndMigrate(projectRoot, role, opts)
//   - role ∈ {'project', 'local'}
//   - reads the config file, determines its current schemaVersion,
//     and throws ConfigVersionTooNewError when the on-disk version
//     exceeds CURRENT_SCHEMA_VERSION. No migrations are performed —
//     legacy migration support was dropped because the fork is not
//     expected to be used with old platform configs.
const CURRENT_SCHEMA_VERSION = 4;

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
      `(plugin ${pluginVersion}). Upgrade the Lift-SDLC plugin.`,
      'CONFIG_VERSION_TOO_NEW'
    );
    this.role = role;
    this.found = found;
    this.max = max;
    this.pluginVersion = pluginVersion;
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
// JSON I/O helpers (intentionally tiny — full helpers live in lib/config.js)
// ---------------------------------------------------------------------------

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
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
// Public API: verifyAndMigrate
// ---------------------------------------------------------------------------

/**
 * Verify a config file is at the current schema version.
 * Throws ConfigVersionTooNewError when the on-disk version exceeds
 * CURRENT_SCHEMA_VERSION. No migrations are performed.
 *
 * @param {string} projectRoot
 * @param {string} role — 'project' | 'local'
 * @param {object} [opts] — accepted for API compatibility; no-op
 * @returns {{ schemaVersion: number, migrated: boolean, backupPath: null, stepsApplied: string[] }}
 */
function verifyAndMigrate(projectRoot, role, opts = {}) {
  const paths = resolveConfigPaths(projectRoot, role);
  const detected = detectCurrentVersion(role, paths);

  if (detected.version === null) {
    return { schemaVersion: CURRENT_SCHEMA_VERSION, migrated: false, backupPath: null, stepsApplied: [] };
  }

  if (detected.version > CURRENT_SCHEMA_VERSION) {
    throw new ConfigVersionTooNewError(
      role,
      detected.version,
      CURRENT_SCHEMA_VERSION,
      getPluginVersion()
    );
  }

  return { schemaVersion: CURRENT_SCHEMA_VERSION, migrated: false, backupPath: null, stepsApplied: [] };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  CURRENT_SCHEMA_VERSION,
  verifyAndMigrate,
  ConfigVersionError,
  ConfigVersionTooNewError,
  // Exposed for tests
  resolveConfigPaths,
  detectCurrentVersion,
  getPluginVersion,
};
