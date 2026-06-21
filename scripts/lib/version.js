/**
 * version.js
 * Shared version-file utilities for Lift-SDLC scripts.
 * Zero external dependencies — Node.js built-ins only.
 *
 * Exports:
 *   detectVersionFile, readVersion, writeVersion,
 *   validateSemver, computeNextVersions, computePreRelease,
 *   parseConventionalCommit, readConfig, writeConfig
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { readSection, writeSection } = require('./config');
const { extractKeys: extractIssueKeys } = require('./issue-keys');

// ---------------------------------------------------------------------------
// Version file detection
// ---------------------------------------------------------------------------

/**
 * Scan projectRoot for a recognised version file (first match wins).
 * Priority order:
 *   1. package.json      → "package.json"
 *   2. Cargo.toml        → "cargo.toml"
 *   3. pyproject.toml    → "pyproject.toml"
 *   4. pubspec.yaml      → "pubspec.yaml"
 *   5. plugin.json → "plugin.json"
 *   6. VERSION           → "version-file"
 *   7. version.txt       → "version-file"
 * @param {string} projectRoot
 * @returns {{ filePath: string, fileType: string } | null}
 */
function detectVersionFile(projectRoot) {
  const candidates = [
    { rel: 'package.json',              fileType: 'package.json'  },
    { rel: 'Cargo.toml',                fileType: 'cargo.toml'    },
    { rel: 'pyproject.toml',            fileType: 'pyproject.toml'},
    { rel: 'pubspec.yaml',              fileType: 'pubspec.yaml'  },
    { rel: 'plugin.json',fileType: 'plugin.json'   },
    { rel: 'VERSION',                   fileType: 'version-file'  },
    { rel: 'version.txt',               fileType: 'version-file'  },
  ];

  for (const { rel, fileType } of candidates) {
    const filePath = path.join(projectRoot, rel);
    if (fs.existsSync(filePath)) {
      return { filePath, fileType };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Reading / writing versions
// ---------------------------------------------------------------------------

/**
 * Read the version string from a detected version file.
 * @param {string} filePath  Absolute path to the version file.
 * @param {string} fileType  One of the fileType strings returned by detectVersionFile.
 * @returns {string|null}
 */
function readVersion(filePath, fileType) {
  const content = fs.readFileSync(filePath, 'utf8');

  if (fileType === 'package.json' || fileType === 'plugin.json') {
    try {
      const parsed = JSON.parse(content);
      return parsed.version || null;
    } catch (_) {
      return null;
    }
  }

  if (fileType === 'cargo.toml' || fileType === 'pyproject.toml') {
    const targetSections =
      fileType === 'cargo.toml'
        ? ['[package]']
        : ['[project]', '[tool.poetry]'];

    const lines = content.split('\n');
    let inTargetSection = false;

    for (const line of lines) {
      // Track section headers
      if (/^\[/.test(line)) {
        const header = line.trim();
        inTargetSection = targetSections.includes(header);
      }
      if (!inTargetSection) continue;

      const match = line.match(/^\s*version\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    }

    return null;
  }

  if (fileType === 'pubspec.yaml') {
    const match = content.match(/^version:\s*(.+)/m);
    return match ? match[1].trim() : null;
  }

  if (fileType === 'version-file') {
    return content.trim() || null;
  }

  return null;
}

/**
 * Write a new version string into a version file, replacing the old one.
 * Throws a descriptive Error if the expected pattern is not found or I/O fails.
 * @param {string} filePath   Absolute path to the version file.
 * @param {string} fileType   One of the fileType strings returned by detectVersionFile.
 * @param {string} oldVersion The version string currently in the file.
 * @param {string} newVersion The replacement version string.
 * @returns {void}
 */
function writeVersion(filePath, fileType, oldVersion, newVersion) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`writeVersion: cannot read "${filePath}": ${err.message}`);
  }

  let updated;

  if (fileType === 'package.json' || fileType === 'plugin.json') {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`writeVersion: invalid JSON in "${filePath}": ${err.message}`);
    }

    if (!Object.prototype.hasOwnProperty.call(parsed, 'version')) {
      throw new Error(`writeVersion: no "version" field found in "${filePath}"`);
    }

    parsed.version = newVersion;

    // Detect indentation from the original content
    const indentMatch = content.match(/^(\s+)"/m);
    const indent = indentMatch ? indentMatch[1] : '  ';
    updated = JSON.stringify(parsed, null, indent);

    // Preserve trailing newline if original had one
    if (content.endsWith('\n')) updated += '\n';
  } else if (fileType === 'cargo.toml' || fileType === 'pyproject.toml') {
    const targetSections =
      fileType === 'cargo.toml'
        ? ['[package]']
        : ['[project]', '[tool.poetry]'];

    const lines = content.split('\n');
    let inTargetSection = false;
    let replaced = false;

    const newLines = lines.map(line => {
      if (/^\[/.test(line)) {
        const header = line.trim();
        inTargetSection = targetSections.includes(header);
      }
      if (!replaced && inTargetSection) {
        const match = line.match(/^(\s*version\s*=\s*")([^"]+)(")/);
        if (match && match[2] === oldVersion) {
          replaced = true;
          return `${match[1]}${newVersion}${match[3]}`;
        }
      }
      return line;
    });

    if (!replaced) {
      throw new Error(
        `writeVersion: version = "${oldVersion}" not found in the expected section of "${filePath}"`
      );
    }

    updated = newLines.join('\n');
  } else if (fileType === 'pubspec.yaml') {
    const pattern = new RegExp(`(^version:\\s*)${escapeRegex(oldVersion)}`, 'm');
    if (!pattern.test(content)) {
      throw new Error(
        `writeVersion: "version: ${oldVersion}" not found in "${filePath}"`
      );
    }
    updated = content.replace(pattern, `$1${newVersion}`);
  } else if (fileType === 'version-file') {
    updated = newVersion + '\n';
  } else {
    throw new Error(`writeVersion: unknown fileType "${fileType}"`);
  }

  try {
    fs.writeFileSync(filePath, updated, 'utf8');
  } catch (err) {
    throw new Error(`writeVersion: cannot write "${filePath}": ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Semver utilities
// ---------------------------------------------------------------------------

/**
 * Validate that a string is a valid semver version (with optional pre-release / build metadata).
 * @param {string} version
 * @returns {boolean}
 */
function validateSemver(version) {
  return /^\d+\.\d+\.\d+(-[\w][\w.-]*)?(\+[\w][\w.-]*)?$/.test(version);
}

/**
 * Compute the next major, minor, and patch versions from the current version.
 * Pre-release suffixes on the current version are ignored for the calculation.
 * @param {string} current  e.g. "1.2.3" or "1.2.3-beta.1"
 * @returns {{ major: string, minor: string, patch: string }}
 */
function computeNextVersions(current) {
  // Strip pre-release suffix
  const base = current.split('-')[0];
  const [maj, min, pat] = base.split('.').map(Number);

  return {
    major: `${maj + 1}.0.0`,
    minor: `${maj}.${min + 1}.0`,
    patch: `${maj}.${min}.${pat + 1}`,
  };
}

/**
 * Compute the next pre-release version for a given label.
 *
 * Rules:
 *  - If current already carries this exact label (e.g. "1.2.3-beta.1", label "beta"):
 *      increment the numeric counter → "1.2.3-beta.2"
 *  - If current carries a different pre-release label:
 *      strip pre-release, apply label with counter 1 → "1.2.3-beta.1"
 *  - If current has no pre-release:
 *      → "<current>-<label>.1"
 *  - Build metadata (after "+") is always stripped from the result.
 * @param {string} current  e.g. "1.2.3", "1.2.3-beta.1", "1.2.3+build"
 * @param {string} label    e.g. "alpha", "beta", "rc"
 * @returns {string}
 */
function computePreRelease(current, label) {
  // Strip build metadata
  const withoutBuild = current.split('+')[0];

  const dashIdx = withoutBuild.indexOf('-');
  if (dashIdx === -1) {
    // No pre-release suffix
    return `${withoutBuild}-${label}.1`;
  }

  const base       = withoutBuild.slice(0, dashIdx);
  const preRelease = withoutBuild.slice(dashIdx + 1); // e.g. "beta.1"

  const dotIdx     = preRelease.lastIndexOf('.');
  if (dotIdx !== -1) {
    const existingLabel   = preRelease.slice(0, dotIdx);
    const existingCounter = preRelease.slice(dotIdx + 1);

    if (existingLabel === label) {
      const num = parseInt(existingCounter, 10);
      const next = Number.isNaN(num) ? 1 : num + 1;
      return `${base}-${label}.${next}`;
    }
  }

  // Different label (or no dot separator) — start fresh
  return `${base}-${label}.1`;
}

// ---------------------------------------------------------------------------
// Conventional commit parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Conventional Commit subject line and optionally extract Jira/project
 * ticket IDs from the subject and body.
 *
 * Pattern: `^(\w+)(\([^)]+\))?(!)?: (.+)$`
 *
 * @param {string} subject - The commit subject line.
 * @param {string} [body=''] - Optional commit body text.
 * @param {string|null} [ticketPrefix=null] - Optional ticket prefix filter (e.g. `"PROJ"`).
 *   When provided, only ticket IDs whose prefix matches are included.
 * @returns {{ type: string, scope: string|null, breaking: boolean, description: string, ticketIds: string[] }}
 */
function parseConventionalCommit(subject, body = '', ticketPrefix = null) {
  const match = subject.match(/^(\w+)(\([^)]+\))?(!)?: (.+)$/);

  // Extract ticket IDs from both subject and body using the canonical
  // issue-key regex (issue #284, task 21). Note: the canonical pattern matches
  // both Jira-style keys [A-Z]{2,10}-\d+ and GitHub-style issue numbers.
  const combined  = `${subject}\n${body || ''}`;
  const ticketIds = extractIssueKeys(combined, ticketPrefix ? { prefix: ticketPrefix } : {});

  if (!match) {
    return { type: 'other', scope: null, breaking: false, description: subject, ticketIds };
  }

  const type        = match[1];
  const scopeRaw    = match[2];               // e.g. "(api)" or undefined
  const bang        = match[3];               // "!" or undefined
  const description = match[4];

  const scope    = scopeRaw ? scopeRaw.slice(1, -1) : null; // strip parens
  const breaking = bang === '!';

  return { type, scope, breaking, description, ticketIds };
}

// ---------------------------------------------------------------------------
// Config helpers (.sdlc/version.json)
// ---------------------------------------------------------------------------

/**
 * Read and parse `.sdlc/version.json` relative to projectRoot.
 * Returns the parsed object, or null if the file does not exist.
 * Throws a descriptive error if the file exists but contains invalid JSON.
 * @param {string} projectRoot
 * @returns {object|null}
 */
function readConfig(projectRoot) {
  return readSection(projectRoot, 'version');
}

/**
 * Write config to the unified `.sdlc/config.json` under the `version` section.
 * @param {string} projectRoot
 * @param {object} config
 * @returns {void}
 */
function writeConfig(projectRoot, config) {
  writeSection(projectRoot, 'version', config);
}

// ---------------------------------------------------------------------------
// Pre-release label validation
// ---------------------------------------------------------------------------

/**
 * Single source of truth for valid pre-release label format.
 * Mirrors the JSON Schema pattern in `schemas/sdlc-config.schema.json` under
 * `versionSection.properties.preRelease.pattern`. Consumed by:
 *  - `scripts/skill/version.js` (CLI arg parsing for `--bump <label>` and `--pre <label>`)
 *  - `scripts/skill/ship.js` (CLI arg parsing for `--bump <label>`)
 *  - `scripts/lib/ship-fields.js` (sdlc.json `ship.bump` validation)
 *  - `skills/setup-sdlc/SKILL.md` (interactive answer validation)
 */
const PRE_RELEASE_LABEL_RE = /^[a-z][a-z0-9]*$/;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe use inside a RegExp literal.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  detectVersionFile,
  readVersion,
  writeVersion,
  validateSemver,
  computeNextVersions,
  computePreRelease,
  parseConventionalCommit,
  readConfig,
  writeConfig,
  PRE_RELEASE_LABEL_RE,
};
