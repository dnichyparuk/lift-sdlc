#!/usr/bin/env node
/**
 * openspec-enrich.js
 * Idempotent enrichment of openspec/config.yaml with a managed block
 * pointing contributors to Lift-SDLC skills.
 *
 * Usage:
 *   node openspec-enrich.js [--remove] [--project-root <path>] [--output-file]
 *
 * Exit codes:
 *   0 = success (action: append | update | unchanged | removed)
 *   1 = error (missing file, I/O error)
 *   2 = unexpected script crash
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { resolveSdlcRoot } = require(path.join(__dirname, '..', 'lib', 'config'));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENSPEC_ENRICH_VERSION = 2;

const BEGIN_RE = /^# BEGIN MANAGED BY lift-sdlc \(v(\d+)\)$/m;
const END_RE   = /^# END MANAGED BY lift-sdlc \(v\d+\)$/m;

const BLOCK_TEMPLATE = `# BEGIN MANAGED BY lift-sdlc (v${OPENSPEC_ENRICH_VERSION})
context: |
  SDLC workflow managed by Lift-SDLC. Do not edit this block manually.
  To update: /setup-sdlc --openspec-enrich. To remove: /setup-sdlc --remove-openspec.

  Contributor workflow:
    1. /plan-sdlc --from-openspec <change-name>  — create an implementation plan from the change
    2. /execute-plan-sdlc                         — execute the plan in waves
    3. /ship-sdlc                                 — commit, review, version, and open a PR

  Do not invoke \`openspec archive\` directly — /ship-sdlc handles archival
  as a conditional pipeline step after validation passes.
# END MANAGED BY lift-sdlc (v${OPENSPEC_ENRICH_VERSION})`;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let remove      = false;
  // C-projectroot (#360): default to main-worktree .sdlc/ root, not cwd.
  let projectRoot = resolveSdlcRoot();
  let outputFile  = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--remove') {
      remove = true;
    } else if (a === '--project-root' && args[i + 1]) {
      projectRoot = args[++i];
    } else if (a === '--output-file') {
      outputFile = true;
    }
  }

  return { remove, projectRoot, outputFile };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Detect the managed block in file content.
 * @param {string} content
 * @returns {{ found: boolean, version: number|null, startIdx: number, endIdx: number }}
 */
function detectBlock(content) {
  const beginMatch = BEGIN_RE.exec(content);
  if (!beginMatch) {
    return { found: false, version: null, startIdx: -1, endIdx: -1 };
  }

  const endMatch = END_RE.exec(content.slice(beginMatch.index + beginMatch[0].length));
  if (!endMatch) {
    return { found: false, version: null, startIdx: -1, endIdx: -1 };
  }

  const version  = parseInt(beginMatch[1], 10);
  const startIdx = beginMatch.index;
  const endIdx   = beginMatch.index + beginMatch[0].length + endMatch.index + endMatch[0].length;

  return { found: true, version, startIdx, endIdx };
}

/**
 * Check whether the file declares a top-level `context:` key OUTSIDE the managed block.
 * The managed block region is sliced out so an in-place update (which produces a new
 * `context:` key inside the block) does not trigger the duplicate-key guard.
 * @param {string} content
 * @param {{ found: boolean, startIdx: number, endIdx: number }} block
 * @returns {boolean}
 */
function hasExistingContextKey(content, block) {
  const outsideBlock = block && block.found
    ? content.slice(0, block.startIdx) + content.slice(block.endIdx)
    : content;
  return /^context\s*:/m.test(outsideBlock);
}

/**
 * Enrich the config file with the managed block.
 * @param {string} configPath  Absolute path to openspec/config.yaml
 * @param {{ remove: boolean }} options
 * @returns {{ action: string, version: number, path: string, changed: boolean, warning?: string }}
 */
function enrich(configPath, { remove } = {}) {
  if (!fs.existsSync(configPath)) {
    return {
      ok: false,
      action: 'missing',
      version: OPENSPEC_ENRICH_VERSION,
      path: configPath,
      changed: false,
      error: 'openspec/config.yaml not found',
    };
  }

  const content = fs.readFileSync(configPath, 'utf8');
  const block   = detectBlock(content);

  // --remove mode
  if (remove) {
    if (!block.found) {
      return {
        ok: true,
        action: 'removed',
        version: OPENSPEC_ENRICH_VERSION,
        path: configPath,
        changed: false,
      };
    }

    // Remove the block and normalize surrounding whitespace
    let before = content.slice(0, block.startIdx);
    let after  = content.slice(block.endIdx);

    // Trim trailing whitespace from before and leading whitespace from after
    before = before.replace(/\n+$/, '\n');
    after  = after.replace(/^\n+/, '');

    const newContent = before + after;
    fs.writeFileSync(configPath, newContent, 'utf8');
    return {
      ok: true,
      action: 'removed',
      version: OPENSPEC_ENRICH_VERSION,
      path: configPath,
      changed: true,
    };
  }

  // No block present → append (unless an existing top-level `context:` key would collide)
  if (!block.found) {
    if (hasExistingContextKey(content, block)) {
      return {
        ok: true,
        action: 'skipped-existing-context',
        version: OPENSPEC_ENRICH_VERSION,
        path: configPath,
        changed: false,
        warning: 'Top-level context: key already present in openspec/config.yaml. Refusing to inject a duplicate. Manually fold Lift-SDLC guidance into your existing context: value, then re-run --openspec-enrich.',
      };
    }
    const separator = content.endsWith('\n') ? '\n' : '\n\n';
    const newContent = content + separator + BLOCK_TEMPLATE + '\n';
    fs.writeFileSync(configPath, newContent, 'utf8');
    return {
      ok: true,
      action: 'append',
      version: OPENSPEC_ENRICH_VERSION,
      path: configPath,
      changed: true,
    };
  }

  // Block at higher version → no-op with warning
  if (block.version > OPENSPEC_ENRICH_VERSION) {
    return {
      ok: true,
      action: 'unchanged',
      version: block.version,
      path: configPath,
      changed: false,
      warning: `Managed block is at v${block.version}, plugin ships v${OPENSPEC_ENRICH_VERSION}. Use --remove to downgrade.`,
    };
  }

  // Block at current version → no-op
  if (block.version === OPENSPEC_ENRICH_VERSION) {
    return {
      ok: true,
      action: 'unchanged',
      version: OPENSPEC_ENRICH_VERSION,
      path: configPath,
      changed: false,
    };
  }

  // Block at lower version → update in place
  // Guard: if the user has a top-level `context:` key OUTSIDE the managed block,
  // replacing the block would produce a duplicate key. Skip with a warning, same
  // as the append-path guard.
  if (hasExistingContextKey(content, block)) {
    return {
      ok: true,
      action: 'skipped-existing-context',
      version: block.version,
      path: configPath,
      changed: false,
      warning: 'Top-level context: key already present outside the managed block in openspec/config.yaml. Refusing to update — a duplicate context: key would result. Manually fold Lift-SDLC guidance into your existing context: value, then re-run --openspec-enrich.',
    };
  }

  const before     = content.slice(0, block.startIdx);
  const after      = content.slice(block.endIdx);
  const newContent = before + BLOCK_TEMPLATE + after;
  fs.writeFileSync(configPath, newContent, 'utf8');

  return {
    ok: true,
    action: 'update',
    version: OPENSPEC_ENRICH_VERSION,
    path: configPath,
    changed: true,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const cli = parseArgs(process.argv);
  const configPath = path.join(cli.projectRoot, 'openspec', 'config.yaml');

  const result = enrich(configPath, { remove: cli.remove });

  const output = JSON.stringify(result, null, 2);

  if (cli.outputFile) {
    const tmpFile = path.join(os.tmpdir(), `openspec-enrich-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, output, 'utf8');
    process.stdout.write(`PREPARE_OUTPUT_FILE=${tmpFile}\n`);
  } else {
    process.stdout.write(output + '\n');
  }

  process.exit(result.ok === false ? 1 : 0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`openspec-enrich.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, detectBlock, enrich, hasExistingContextKey, OPENSPEC_ENRICH_VERSION };
