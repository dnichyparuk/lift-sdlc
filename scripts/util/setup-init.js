#!/usr/bin/env node
/**
 * setup-init.js
 * Deterministically creates the .sdlc/ directory structure and config files.
 * The LLM runs the interactive walkthrough, then calls this script with
 * the collected answers as flags.
 *
 * Usage:
 *   node setup-init.js [options]
 *
 * Options:
 *   --project-config '<json>'  JSON object for .sdlc/config.json sections
 *   --local-config '<json>'    JSON object for .sdlc/local.json sections
 *   --output-file              Write JSON to temp file (path on stdout)
 *
 * Exit codes:
 *   0 = success, JSON on stdout
 *   1 = validation error, JSON with non-empty errors[] on stdout
 *   2 = unexpected script crash, message on stderr
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');

const {
  readProjectConfig,
  readLocalConfig,
  writeProjectConfig,
  writeLocalConfig,
  ensureSdlcGitignore,
  ensureRootGitignore,
} = require(path.join(LIB, 'config'));
const { writeOutput } = require(path.join(LIB, 'output'));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let projectConfig = null;
  let localConfig   = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--project-config' && args[i + 1]) {
      projectConfig = args[++i];
    } else if (a === '--local-config' && args[i + 1]) {
      localConfig = args[++i];
    }
  }

  return { projectConfig, localConfig };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(parsed) {
  const errors = [];

  if (parsed.projectConfig !== null) {
    try {
      JSON.parse(parsed.projectConfig);
    } catch (e) {
      errors.push(`--project-config is not valid JSON: ${e.message}`);
    }
  }

  if (parsed.localConfig !== null) {
    try {
      JSON.parse(parsed.localConfig);
    } catch (e) {
      errors.push(`--local-config is not valid JSON: ${e.message}`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Backup rotation (issue #231 R-layout-6)
// ---------------------------------------------------------------------------

const BACKUP_RETAIN = 3;

function sweepBackups(projectRoot, warnings) {
  const candidates = [];
  const sdlcDir = path.join(projectRoot, '.sdlc');

  // .sdlc/*.bak.* — group by base filename so each role retains 3 newest.
  if (fs.existsSync(sdlcDir)) {
    for (const entry of fs.readdirSync(sdlcDir)) {
      const m = /^(.+?)\.bak\..+$/.exec(entry);
      if (m) {
        const full = path.join(sdlcDir, entry);
        const stat = fs.statSync(full);
        candidates.push({ full, base: m[1], mtimeMs: stat.mtimeMs });
      }
    }
  }
  // .sdlc/sdlc.json.bak.<ts> (only the legacy relocation produces .bak.<ts>; the
  // bare .sdlc/sdlc.json.bak is preserved as the single legacy backup).
  if (fs.existsSync(sdlcDir)) {
    for (const entry of fs.readdirSync(sdlcDir)) {
      const m = /^(sdlc\.json)\.bak\..+$/.exec(entry);
      if (m) {
        const full = path.join(sdlcDir, entry);
        const stat = fs.statSync(full);
        candidates.push({ full, base: 'antigravity:' + m[1], mtimeMs: stat.mtimeMs });
      }
    }
  }

  // Group by base, sort each group by mtime desc, unlink past index BACKUP_RETAIN-1.
  const byBase = new Map();
  for (const c of candidates) {
    if (!byBase.has(c.base)) byBase.set(c.base, []);
    byBase.get(c.base).push(c);
  }
  for (const [base, group] of byBase.entries()) {
    group.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = BACKUP_RETAIN; i < group.length; i++) {
      try {
        fs.unlinkSync(group[i].full);
      } catch (err) {
        warnings.push(`Failed to remove stale backup ${group[i].full}: ${err.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // setup-init operates on cwd; resolveSdlcRoot() requires existing main-worktree resolution.
  // This is the bootstrap path — it CREATES .sdlc/ in first-time runs where no main worktree
  // context is yet established. See issue #351 for the exception rationale.
  // KEEP: bootstrap (creates .sdlc/ before main-worktree context exists) — do not change to resolveSdlcRoot()
  const projectRoot = process.cwd();
  const cli = parseArgs(process.argv);

  const errors   = [];
  const warnings = [];

  // Validate inputs
  const validationErrors = validate(cli);
  if (validationErrors.length > 0) {
    errors.push(...validationErrors);
    writeOutput({ errors, warnings }, 'setup-init', 1);
    return;
  }

  // 1. Create .sdlc/ directory and .gitignore (selective ignores per issue #231).
  const gitignoreAction = ensureSdlcGitignore(projectRoot);
  if (gitignoreAction === 'unchanged') {
    warnings.push('.sdlc/.gitignore already up-to-date — skipped');
  }

  // 1c. Backup rotation sweep — keep the 3 newest .bak files per role
  // (issue #231 R-layout-6). Looks at .sdlc/*.bak.* and .sdlc/sdlc.json.bak.*
  // (the legacy single backup is also rotated if multiple appear).
  try {
    sweepBackups(projectRoot, warnings);
  } catch (err) {
    warnings.push(`Backup rotation sweep failed: ${err.message}`);
  }

  // 1b. Ensure managed block in project-root .gitignore (issue #209 — defence
  // in depth against transient skill artifacts leaking into VCS). Project-
  // agnostic: works in any consumer repo.
  const rootGitignoreAction = ensureRootGitignore(projectRoot);

  // 2. Write project config (.sdlc/config.json) if sections provided
  let projectConfigAction = 'skipped';
  if (cli.projectConfig !== null) {
    const config = JSON.parse(cli.projectConfig);
    if (Object.keys(config).length > 0) {
      const existing = readProjectConfig(projectRoot);
      projectConfigAction = existing.config ? 'overwritten' : 'created';
      writeProjectConfig(projectRoot, config);
    }
  }

  // 3. Write local config (.sdlc/local.json) if sections provided
  let localConfigAction = 'skipped';
  if (cli.localConfig !== null) {
    const config = JSON.parse(cli.localConfig);
    if (Object.keys(config).length > 0) {
      const existing = readLocalConfig(projectRoot);
      localConfigAction = existing.config ? 'overwritten' : 'created';
      writeLocalConfig(projectRoot, config);
    }
  }

  const result = {
    errors,
    warnings,
    created: {
      directory: '.sdlc/',
      gitignore:     { path: '.sdlc/.gitignore',  action: gitignoreAction },
      rootGitignore: { path: '.gitignore',         action: rootGitignoreAction },
      projectConfig: { path: '.sdlc/config.json',  action: projectConfigAction },
      localConfig:   { path: '.sdlc/local.json',   action: localConfigAction },
    },
  };

  writeOutput(result, 'setup-init', 0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`setup-init.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, validate };
