#!/usr/bin/env node
/**
 * @file ci/validate-guardrails.js
 * @description Validates guardrail definitions in .sdlc/config.json (issue #231;
 *   legacy .sdlc/sdlc.json read via lib/config.js fallback): checks schema
 *   compliance, id uniqueness, severity values, and description quality.
 * @exit 0 all checks pass, 1 validation issues found
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');

const { resolveSdlcRoot } = require(path.join(LIB, 'config'));
const { GUARDRAIL_SEVERITIES } = require(path.join(LIB, 'dimensions'));

/**
 * Parse command-line flags.
 *
 * `--project-root <dir>` (default) resolves `.sdlc/config.json` under a
 * directory via readSection, mirroring every other project-root-rooted CLI.
 * `--config-file <path>` instead names an explicit config file to parse and
 * validate directly — used when the caller already holds a specific file
 * (e.g. a `.harden-tmp` staging copy) rather than a project directory.
 * `--config-file` and an explicit `--project-root` are mutually exclusive;
 * passing both is a usage error (exit 1) — see main().
 */
function parseArgs(args) {
  const result = {
    // C-projectroot (#360): default to main-worktree .sdlc/ root, not cwd.
    projectRoot: resolveSdlcRoot(),
    explicitProjectRoot: false,
    configFile: null,
    json: false,
    section: 'plan',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-root' && i + 1 < args.length) {
      result.projectRoot = args[i + 1];
      result.explicitProjectRoot = true;
      i++;
    } else if (args[i] === '--config-file' && i + 1 < args.length) {
      result.configFile = args[i + 1];
      i++;
    } else if (args[i] === '--json') {
      result.json = true;
    } else if (args[i] === '--section' && i + 1 < args.length) {
      result.section = args[i + 1];
      i++;
    }
  }
  return result;
}

/**
 * Import readSection from lib/config.js
 */
function loadReadSection() {
  const configPath = path.join(LIB, 'config.js');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Could not find lib/config.js at ${configPath}`);
  }

  const config = require(configPath);
  if (typeof config.readSection !== 'function') {
    throw new Error('readSection not exported from lib/config.js');
  }

  return config.readSection;
}

/**
 * Validate a single guardrail
 * @returns {object} { id, status, errors, warnings }
 */
function validateGuardrail(guardrail, seenIds) {
  const errors = [];
  const warnings = [];
  const result = {
    id: guardrail.id || '(missing)',
    status: 'PASS',
    errors,
    warnings,
  };

  // Validate id exists and is string
  if (!guardrail.id) {
    errors.push('id is missing');
    result.status = 'FAIL';
  } else if (typeof guardrail.id !== 'string') {
    errors.push('id must be a string');
    result.status = 'FAIL';
  } else {
    // Validate kebab-case pattern
    const kebabPattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    if (!kebabPattern.test(guardrail.id)) {
      errors.push(`id must match kebab-case pattern: /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`);
      result.status = 'FAIL';
    }

    // Validate no duplicate IDs
    if (seenIds.has(guardrail.id)) {
      errors.push(`id is duplicated across guardrails`);
      result.status = 'FAIL';
    } else {
      seenIds.add(guardrail.id);
    }
  }

  // Validate description exists and is non-empty string
  if (!guardrail.description) {
    errors.push('description is missing');
    result.status = 'FAIL';
  } else if (typeof guardrail.description !== 'string') {
    errors.push('description must be a string');
    result.status = 'FAIL';
  } else if (guardrail.description.trim() === '') {
    errors.push('description cannot be empty');
    result.status = 'FAIL';
  }

  // Validate description length <= 512
  if (guardrail.description && guardrail.description.length > 512) {
    errors.push(`description exceeds 512 characters (${guardrail.description.length} chars)`);
    result.status = 'FAIL';
  }

  // Validate severity is valid (optional, defaults to error) — R17: use GUARDRAIL_SEVERITIES as source of truth
  if (guardrail.severity !== undefined && guardrail.severity !== null) {
    if (!GUARDRAIL_SEVERITIES.has(guardrail.severity)) {
      errors.push(`severity must be ${[...GUARDRAIL_SEVERITIES].map(s => `"${s}"`).join(', ')}, or undefined (got "${guardrail.severity}")`);
      result.status = 'FAIL';
    }
  }

  return result;
}

/**
 * Validate an already-resolved guardrails section value — pure function, no
 * I/O, no readSection. This is the half of the old validateGuardrailsConfig
 * that actually validates; the other half (locating the section value, via
 * project-root + readSection OR an explicit --config-file) now lives in
 * resolveSectionData(). Exported so both CLI modes and future callers can
 * validate a section object they already hold.
 *
 * @param {object|null} sectionValue — the section object (e.g. what
 *   readSection(root, 'plan') or config.plan would yield), or null/undefined
 *   when nothing is configured
 * @param {string} sectionName — 'plan' | 'execute' (or any section) — used
 *   only to prefix per-guardrail error/warning messages
 * @returns {{ errors: string[], warnings: string[], guardrailCount: number }}
 */
function validateGuardrailsSection(sectionValue, sectionName) {
  const errors = [];
  const warnings = [];

  if (!sectionValue || !Array.isArray(sectionValue.guardrails)) {
    return { errors, warnings, guardrailCount: 0 };
  }

  const guardrails = sectionValue.guardrails;
  const seenIds = new Set();

  for (const guardrail of guardrails) {
    const validation = validateGuardrail(guardrail, seenIds);
    for (const err of validation.errors) {
      errors.push(`${validation.id}: ${err}`);
    }
    for (const warn of validation.warnings) {
      warnings.push(`${validation.id}: ${warn}`);
    }
  }

  return { errors, warnings, guardrailCount: guardrails.length };
}

/**
 * Validate guardrail config for a given section — no process.exit, no console output.
 * Exported for programmatic use by harden-prepare.js (R16). Signature and
 * behavior unchanged: still resolves the section via project-root + readSection,
 * now delegating the actual validation to validateGuardrailsSection().
 *
 * @param {string} projectRoot — absolute path to the project root
 * @param {string} sectionName — 'plan' | 'execute' (or any readSection key)
 * @returns {{ errors: string[], warnings: string[], guardrailCount: number }}
 */
function validateGuardrailsConfig(projectRoot, sectionName) {
  let readSection;
  try {
    readSection = loadReadSection(projectRoot);
  } catch (err) {
    return { errors: [`Cannot load readSection: ${err.message}`], warnings: [], guardrailCount: 0 };
  }

  const section = sectionName || 'plan';
  let sectionData;
  try {
    sectionData = readSection(projectRoot, section);
  } catch (err) {
    return { errors: [`Cannot read section "${section}": ${err.message}`], warnings: [], guardrailCount: 0 };
  }

  return validateGuardrailsSection(sectionData, section);
}

/**
 * Locate the guardrails section value for the given parsed flags, without
 * validating its contents — this is the "locating" half split out of the old
 * validateGuardrailsConfig (see module doc / task contract).
 *
 * `--config-file` mode reads and JSON.parses the named file directly, then
 * indexes into it the same way readSection does for project-config sections
 * (`config?.[section] ?? null` — see scripts/lib/config.js readSection,
 * PROJECT_SECTIONS branch), so a `.sdlc/config.json`-shaped file yields
 * identical results whether read via --project-root or via --config-file.
 * A missing --config-file target fails loudly (exit 1 from main()), unlike
 * project-root mode's graceful "no guardrails configured" fallback — setup
 * flows legitimately run project-root mode before any guardrails exist, but
 * an explicit --config-file target (e.g. a harden `.harden-tmp` staging
 * copy) is expected to exist.
 *
 * @param {{projectRoot: string, configFile: string|null}} flags
 * @param {string} section
 * @returns {object|null}
 * @throws {Error} with `.code === 'CONFIG_FILE_NOT_FOUND'` when --config-file
 *   is set but the target does not exist, or `.code === 'CONFIG_FILE_INVALID_JSON'`
 *   when the target exists but fails to parse; other failures (readSection
 *   errors) propagate as plain Errors.
 */
function resolveSectionData(flags, section) {
  if (flags.configFile) {
    if (!fs.existsSync(flags.configFile)) {
      const err = new Error(`Config file not found: ${flags.configFile}`);
      err.code = 'CONFIG_FILE_NOT_FOUND';
      throw err;
    }
    let config;
    try {
      config = JSON.parse(fs.readFileSync(flags.configFile, 'utf8'));
    } catch (parseErr) {
      const err = new Error(`Invalid JSON in ${flags.configFile}: ${parseErr.message}`);
      err.code = 'CONFIG_FILE_INVALID_JSON';
      throw err;
    }
    return config?.[section] ?? null;
  }

  const readSection = loadReadSection(flags.projectRoot);
  return readSection(flags.projectRoot, section);
}

/**
 * Main validation logic — thin CLI wrapper around resolveSectionData() +
 * validateGuardrailsSection().
 */
function main() {
  const args = process.argv.slice(2);
  const flags = parseArgs(args);
  const section = flags.section || 'plan';

  if (flags.configFile && flags.explicitProjectRoot) {
    process.stderr.write('--config-file and --project-root are mutually exclusive; pass only one\n');
    process.exit(1);
  }

  let sectionData;
  try {
    sectionData = resolveSectionData(flags, section);
  } catch (err) {
    if (err.code === 'CONFIG_FILE_NOT_FOUND' || err.code === 'CONFIG_FILE_INVALID_JSON') {
      process.stderr.write(err.message + '\n');
      process.exit(1);
    }
    process.stderr.write('CRASH: ' + err.message + '\n');
    process.exit(2);
  }

  try {
    const result = validateGuardrailsSection(sectionData, section);

    // If no guardrails configured, treat as pass
    if (result.guardrailCount === 0 && result.errors.length === 0) {
      const output = {
        overall: 'pass',
        summary: { total: 0, pass: 0, errors: 0, warnings: 0 },
        guardrails: [],
      };
      if (flags.json) {
        process.stdout.write(JSON.stringify(output, null, 2) + '\n');
      } else {
        process.stdout.write(`No ${section} guardrails configured.\n`);
      }
      process.exit(0);
    }

    // Re-run per-guardrail validation for structured output (needed for CLI display)
    const guardrails = sectionData ? (sectionData.guardrails || []) : [];
    const seenIds = new Set();
    const results = [];

    let totalPass = 0;
    let totalFail = 0;
    let totalWarnings = 0;

    for (const guardrail of guardrails) {
      const validation = validateGuardrail(guardrail, seenIds);
      results.push(validation);

      if (validation.status === 'PASS') {
        totalPass++;
      } else {
        totalFail++;
      }
      totalWarnings += validation.warnings.length;
    }

    const overall = totalFail === 0 ? 'pass' : 'fail';
    const output = {
      overall,
      summary: {
        total: guardrails.length,
        pass: totalPass,
        errors: totalFail,
        warnings: totalWarnings,
      },
      guardrails: results,
    };

    if (flags.json) {
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    } else {
      process.stdout.write(`Guardrails: ${totalPass}/${guardrails.length} passed\n`);
      for (const result of results) {
        const statusStr = result.status === 'PASS' ? '✓' : '✗';
        process.stdout.write(`  ${statusStr} ${result.id}\n`);
        for (const err of result.errors) {
          process.stdout.write(`    ERROR: ${err}\n`);
        }
        for (const warn of result.warnings) {
          process.stdout.write(`    WARNING: ${warn}\n`);
        }
      }
    }

    process.exit(overall === 'pass' ? 0 : 1);
  } catch (err) {
    process.stderr.write('CRASH: ' + err.message + '\n');
    process.exit(2);
  }
}

module.exports = { validateGuardrailsConfig, validateGuardrailsSection };

if (require.main === module) {
  main();
}
