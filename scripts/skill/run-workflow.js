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

function getCurrentBranch() {
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch (_) {
    // fall through
  }
  return null;
}

/**
 * Generic --resume support for pipelines whose prepareScript doesn't
 * implement its own resume detection (e.g. ship.js already has a more
 * sophisticated implicit-resume wrapper around
 * `lib/state.js::detectResumeState` — this injection only fills the gap
 * for prepareScripts that leave `flags.resume`/`resume` unset).
 *
 * Mutates the JSON file at `outputFilePath` in place when applicable.
 * Returns true if an `implicitResumeNoState` error was injected (caller
 * uses this to escalate a 0 exit code to 1, matching this script's
 * documented "1 = validation or prepare error" contract).
 */
function injectResumeInfo(outputFilePath, manifest, forwarded) {
  if (!outputFilePath || !fs.existsSync(outputFilePath)) return false;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(outputFilePath, 'utf8'));
  } catch (_) {
    return false; // stdout wasn't a manifest file path we understand
  }
  if (!data || typeof data !== 'object') return false;

  // Don't override a prepareScript's own resume handling.
  if (data.flags && data.flags.resume !== undefined) return false;
  if (data.resume !== undefined) return false;

  const resumeRequested = forwarded.includes('--resume');
  if (!resumeRequested) return false;

  const statePrefix = manifest.statePrefix || manifest.pipeline;
  if (!statePrefix) return false;

  const branch = (data.context && data.context.currentBranch) || getCurrentBranch();
  if (!branch) return false;

  const { detectResumeState } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'state.js'));
  const resume = detectResumeState({ prefix: statePrefix, branch });

  data.flags = data.flags || {};
  let injectedError = false;

  if (resume && resume.found) {
    data.flags.resume = true;
    data.resume = {
      found: true,
      stateFile: resume.stateFile,
      nextPendingStep: resume.nextPendingStep,
    };
  } else {
    data.flags.resume = false;
    data.resume = { found: false };
    data.errors = Array.isArray(data.errors) ? data.errors : [];
    data.errors.push({
      id: 'implicitResumeNoState',
      message: `--resume was passed but no state file was found for pipeline "${statePrefix}" on branch "${branch}". Run without --resume to start fresh.`,
    });
    injectedError = true;
  }

  fs.writeFileSync(outputFilePath, JSON.stringify(data, null, 2) + '\n');
  return injectedError;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let manifestPath = null;
  const forwarded = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--manifest' && args[i + 1]) {
      manifestPath = args[++i];
    } else if (args[i] === '--manifest') {
      manifestPath = null;
    } else {
      forwarded.push(args[i]);
    }
  }

  return { manifestPath, forwarded };
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
    stdio: ['inherit', 'pipe', 'inherit'],
    env: process.env,
  });

  if (result.error) {
    process.stderr.write(`Error launching prepare script: ${result.error.message}\n`);
    process.exit(2);
  }

  const stdoutText = result.stdout ? result.stdout.toString('utf8') : '';
  const outputFilePath = stdoutText.trim();
  let exitCode = result.status !== null ? result.status : 1;

  const injectedError = injectResumeInfo(outputFilePath, manifest, forwarded);
  if (injectedError && exitCode === 0) {
    exitCode = 1;
  }

  if (stdoutText) {
    process.stdout.write(stdoutText.endsWith('\n') ? stdoutText : stdoutText + '\n');
  }

  process.exit(exitCode);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, resolveManifest, injectResumeInfo, getCurrentBranch };
