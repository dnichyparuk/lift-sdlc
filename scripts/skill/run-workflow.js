#!/usr/bin/env node
/**
 * run-workflow.js
 * Generic prepare-script wrapper for the run-workflow engine.
 * Reads a pipeline manifest (--manifest <path>), resolves its prepareScript,
 * and delegates execution with all forwarded arguments.
 *
 * Usage:
 *   node run-workflow.js --manifest <path> [pipeline-flags]
 *
 * Exit codes:
 *   0 = success (stdout forwarded from prepare script)
 *   1 = validation or prepare error
 *   2 = unexpected crash / missing manifest
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.join(__dirname, '..', '..');

function parseArgs(argv) {
  const args = argv.slice(2);
  let manifestPath = null;
  let outputFile = false;
  const forwarded = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--manifest' && args[i + 1]) {
      manifestPath = args[++i];
    } else if (args[i] === '--output-file') {
      outputFile = true;
      forwarded.push(args[i]);
    } else {
      forwarded.push(args[i]);
    }
  }

  return { manifestPath, outputFile, forwarded };
}

function resolveManifest(manifestArg) {
  if (!manifestArg) return null;
  // Try relative to cwd, then relative to PLUGIN_ROOT
  const fromCwd = path.resolve(process.cwd(), manifestArg);
  if (fs.existsSync(fromCwd)) return fromCwd;

  const fromPlugin = path.resolve(PLUGIN_ROOT, manifestArg);
  if (fs.existsSync(fromPlugin)) return fromPlugin;

  return fromCwd;
}

function main() {
  const { manifestPath, forwarded } = parseArgs(process.argv);

  if (!manifestPath) {
    process.stderr.write('Error: --manifest <path> is required\n');
    process.exit(1);
  }

  const resolvedManifest = resolveManifest(manifestPath);
  if (!resolvedManifest || !fs.existsSync(resolvedManifest)) {
    process.stderr.write(`Error: manifest file not found: ${manifestPath}\n`);
    process.exit(1);
  }

  let manifest;
  try {
    const raw = fs.readFileSync(resolvedManifest, 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`Error: invalid manifest JSON: ${err.message}\n`);
    process.exit(1);
  }

  if (!manifest.prepareScript) {
    process.stderr.write('Error: manifest missing "prepareScript" property\n');
    process.exit(1);
  }

  // Resolve prepare script relative to PLUGIN_ROOT or cwd
  let preparePath = path.resolve(PLUGIN_ROOT, manifest.prepareScript);
  if (!fs.existsSync(preparePath)) {
    preparePath = path.resolve(process.cwd(), manifest.prepareScript);
  }

  if (!fs.existsSync(preparePath)) {
    process.stderr.write(`Error: prepare script not found: ${manifest.prepareScript}\n`);
    process.exit(1);
  }

  const result = spawnSync(process.execPath, [preparePath, ...forwarded], {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    process.stderr.write(`Error launching prepare script: ${result.error.message}\n`);
    process.exit(2);
  }

  process.exit(result.status !== null ? result.status : 1);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, resolveManifest };
