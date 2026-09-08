#!/usr/bin/env node
'use strict';

/**
 * review-cleanup.js — Cleans up the review-sdlc diff manifest and its
 * temporary diff directory after review-orchestrator finishes.
 *
 * Direct 1:1 port of skills/review-sdlc/scripts/cleanup.sh's inline
 * `node -e` filesystem cleanup, preserving its logic verbatim:
 *   - Read the manifest JSON's `diff_dir` field.
 *   - Safety check: only rm -rf the directory if its path contains the
 *     literal substring `sdlc-review-` (never relaxed/removed — this is a
 *     destructive-delete guard).
 *   - Delete the manifest file itself.
 *   - Any failure along the way is swallowed and reported as a warning on
 *     stderr rather than thrown (cleanup.sh:20-22).
 *
 * Usage:
 *   node review-cleanup.js <manifest-file-path>
 *
 * Exit codes:
 *   0 = success (including "nothing to clean up" and "cleanup failed but
 *       swallowed", matching cleanup.sh's always-exit-0 behavior once past
 *       the missing-argument check)
 *   2 = usage error (no MANIFEST_FILE provided, matching cleanup.sh:2)
 *
 * Zero npm dependencies — Node.js built-ins only.
 */

const fs = require('node:fs');

function parseArgs(argv) {
  return { manifestFile: argv[2] || null };
}

/**
 * Runs the cleanup. Writes warnings to stderr and returns an exit code
 * (does not call process.exit — callers decide when to exit).
 *
 * @param {string} manifestFile
 * @param {object} [deps] injectable fs-shaped dependencies (for tests)
 * @param {{write: (s: string) => void}} [deps.stderr]
 */
function cleanup(manifestFile, deps = {}) {
  const {
    existsSync = fs.existsSync,
    readFileSync = fs.readFileSync,
    rmSync = fs.rmSync,
    unlinkSync = fs.unlinkSync,
    stderr = process.stderr,
  } = deps;

  try {
    if (existsSync(manifestFile)) {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      const diffDir = manifest.diff_dir;

      // Safety check: ensure we only delete temporary review directories
      if (diffDir && diffDir.includes('sdlc-review-') && existsSync(diffDir)) {
        rmSync(diffDir, { recursive: true, force: true });
      }

      // Clean up the manifest itself
      unlinkSync(manifestFile);
    }
  } catch (e) {
    stderr.write('Warning: Cleanup failed - ' + e.message + '\n');
  }
}

/**
 * @param {string[]} argv process.argv
 * @param {object} [deps]
 * @returns {number} exit code
 */
function main(argv, deps = {}) {
  const { stderr = process.stderr } = deps;
  const { manifestFile } = parseArgs(argv);

  if (!manifestFile) {
    stderr.write('ERROR: No MANIFEST_FILE provided.\n');
    return 2;
  }

  cleanup(manifestFile, deps);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { parseArgs, cleanup, main };
