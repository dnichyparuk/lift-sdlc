#!/usr/bin/env node
/**
 * scaffold-ci.js
 * Deterministically copies CI scripts and workflow files into a user project.
 *
 * Usage:
 *   node scaffold-ci.js [options]
 *
 * Options:
 *   --changelog       Include changelog CI scripts/workflows
 *   --force           Overwrite existing files
 *   --check-only      Report version status without writing files
 *   --output-file     Write JSON to temp file (path on stdout)
 *
 * Exit codes:
 *   0 = success, JSON on stdout (or temp file path with --output-file)
 *   1 = validation error (JSON with non-empty errors[])
 *   2 = unexpected script crash (message on stderr)
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const LIB  = path.join(__dirname, '..', 'lib');

const { writeOutput } = require(path.join(LIB, 'output'));
const { resolveSdlcRoot } = require(path.join(LIB, 'config'));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Plugin root relative to this script: scripts/util/ → plugin root */
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

/**
 * File manifest. Each entry maps a plugin source to a project destination.
 * versionRegex extracts the version constant from the installed file.
 */
const MANIFEST = [
  {
    src:  path.join('scripts', 'ci', 'retag-release.cjs'),
    dest: path.join('.github', 'scripts', 'retag-release.cjs'),
    versionRegex: /const\s+RETAG_SCRIPT_VERSION\s*=\s*(\d+)/,
    versionConst: 'RETAG_SCRIPT_VERSION',
    group: 'retag',
  },
  {
    src:  path.join('templates', 'retag-release.yml'),
    dest: path.join('.github', 'workflows', 'retag-release.yml'),
    versionRegex: /^#\s*retag-release-version:\s*(\d+)/m,
    versionConst: 'retag-release-version',
    group: 'retag',
  },
  {
    src:  path.join('scripts', 'ci', 'check-changelog.cjs'),
    dest: path.join('.github', 'scripts', 'check-changelog.cjs'),
    versionRegex: /const\s+CHECK_CHANGELOG_SCRIPT_VERSION\s*=\s*(\d+)/,
    versionConst: 'CHECK_CHANGELOG_SCRIPT_VERSION',
    group: 'changelog',
  },
  {
    src:  path.join('templates', 'check-changelog.yml'),
    dest: path.join('.github', 'workflows', 'check-changelog.yml'),
    versionRegex: /^#\s*check-changelog-version:\s*(\d+)/m,
    versionConst: 'check-changelog-version',
    group: 'changelog',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractVersion(content, regex) {
  const match = content.match(regex);
  return match ? parseInt(match[1], 10) : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    changelog: args.includes('--changelog'),
    force:     args.includes('--force'),
    checkOnly: args.includes('--check-only'),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // C-projectroot (#360): route to the main worktree's .sdlc/ root.
  const projectRoot = resolveSdlcRoot();
  const cli = parseArgs(process.argv);

  const errors   = [];
  const warnings = [];
  const files    = [];

  // Filter manifest by flags
  const entries = MANIFEST.filter(e => {
    if (e.group === 'changelog' && !cli.changelog) return false;
    return true;
  });

  for (const entry of entries) {
    const srcPath  = path.join(PLUGIN_ROOT, entry.src);
    const destPath = path.join(projectRoot, entry.dest);

    // Read source file
    if (!fs.existsSync(srcPath)) {
      errors.push(`Source file not found: ${entry.src}`);
      continue;
    }
    const srcContent = fs.readFileSync(srcPath, 'utf8');
    const currentVersion = extractVersion(srcContent, entry.versionRegex);

    // Check destination
    const destExists = fs.existsSync(destPath);
    let installedVersion = null;
    let action = 'none';

    if (destExists) {
      const destContent = fs.readFileSync(destPath, 'utf8');
      installedVersion = extractVersion(destContent, entry.versionRegex);
    }

    if (cli.checkOnly) {
      // Report-only mode
      if (!destExists) {
        action = 'missing';
      } else if (installedVersion < currentVersion) {
        action = 'outdated';
      } else {
        action = 'current';
      }
    } else {
      // Write mode
      if (!destExists) {
        action = 'created';
      } else if (cli.force) {
        action = 'overwritten';
      } else if (installedVersion < currentVersion) {
        action = 'outdated';
        warnings.push(`${entry.dest} is outdated (installed: v${installedVersion}, current: v${currentVersion}). Use --force to update.`);
      } else {
        action = 'skipped';
      }

      if (action === 'created' || action === 'overwritten' || action === 'migrated') {
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        fs.writeFileSync(destPath, srcContent, 'utf8');
      }
    }

    files.push({
      path: entry.dest,
      action,
      installedVersion,
      currentVersion,
      group: entry.group,
    });
  }

  const result = { errors, warnings, files };
  writeOutput(result, 'scaffold-ci', errors.length > 0 ? 1 : 0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`scaffold-ci.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { MANIFEST, extractVersion };
