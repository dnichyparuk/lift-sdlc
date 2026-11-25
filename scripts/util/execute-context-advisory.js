#!/usr/bin/env node
/**
 * execute-context-advisory.js
 * Node port of the former `skills/execute-plan-sdlc/scripts/context_advisory.sh`.
 * Combines `readSection()` (scripts/lib/config.js) with `getAdvisory()`
 * (scripts/lib/context-advisory.js), preserving the original's
 * try/catch-swallow-missing-sidecar behavior (context_advisory.sh:8-16):
 * a missing helper or unreadable sidecar is silently ignored, never fatal.
 *
 * Usage:
 *   node execute-context-advisory.js [--meta] [--cwd <path>]
 *
 * Behavior:
 *   - Prints the context-heaviness advisory text to stderr when the
 *     transcript-stats sidecar reports `heavy: true` (no advisory otherwise).
 *   - Without `--meta` (default): prints the `execute.guardrails` array (from
 *     project config) as a single JSON line on stdout — consumed inline by
 *     the SKILL.md caller via command substitution (no --output-file manifest
 *     here, matching the original script's direct `console.log(JSON.stringify(...))`
 *     stdout).
 *   - With `--meta`: prints `{ guardrails, advisory, standardWorkerEnum,
 *     priorWaveContextCaps }` as a single JSON line on stdout, merging
 *     `.sdlc/local.json` over `.sdlc/config.json` via `readSection(root, 'execute')`.
 *
 * Exit codes:
 *   0 = success (guardrails JSON printed, advisory printed to stderr if any)
 *   2 = unexpected script crash (e.g. scripts/lib/config.js missing)
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');

const { readSection, resolveSdlcRoot } = require(path.join(LIB, 'config'));
const { getAdvisory }  = require(path.join(LIB, 'context-advisory'));
const { writeJsonLine } = require(path.join(LIB, 'output'));
const { recordGuardrailEvaluation } = require(path.join(LIB, 'learnings'));

const SKILL_NAME = 'execute-plan-sdlc';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse CLI flags (`--meta`, `--cwd <path>`).
 * Returns `{}` when no flags are passed for backwards compatibility.
 * @param {string[]} argv
 * @returns {{ meta?: boolean, cwd?: string }}
 */
function parseArgs(argv) {
  const raw = Array.isArray(argv) ? argv : [];
  const args = (raw.length >= 2 && !String(raw[0]).startsWith('-')) ? raw.slice(2) : raw;
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--meta') {
      opts.meta = true;
    } else if (a === '--cwd') {
      if (i + 1 >= args.length || args[i + 1] === '' || args[i + 1].startsWith('-')) {
        throw new Error('--cwd requires a directory path argument');
      }
      opts.cwd = args[++i];
    } else if (typeof a === 'string' && a.startsWith('--cwd=')) {
      const val = a.slice('--cwd='.length);
      if (!val) {
        throw new Error('--cwd requires a directory path argument');
      }
      opts.cwd = val;
    }
  }

  return opts;
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function resolveStandardWorkerEnum(execute) {
  const raw = execute && execute.standardWorkerEnum;
  return raw === 'pro' || raw === 'inherit' ? raw : 'pro';
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Resolve the execute-guardrails array, execution metadata, and (best-effort) context advisory.
 *
 * @param {string} cwd  Working directory to read project config from
 * @param {{ readSectionFn?: Function, getAdvisoryFn?: Function, recordGuardrailEvaluationFn?: Function }} [deps]  Injectable for tests
 * @returns {{ guardrails: Array, advisory: string|null, standardWorkerEnum: 'pro'|'inherit', priorWaveContextCaps: object|null }}
 */
function runExecuteContextAdvisory(cwd, {
  readSectionFn = readSection,
  getAdvisoryFn = getAdvisory,
  recordGuardrailEvaluationFn = recordGuardrailEvaluation,
} = {}) {
  let advisory = null;
  try {
    advisory = getAdvisoryFn({ skill: SKILL_NAME });
  } catch (_) {
    // helper missing or sidecar unreadable — silent (mirrors context_advisory.sh:8-16)
  }

  const execute = readSectionFn(cwd, 'execute');
  const guardrails = Array.isArray(execute && execute.guardrails) ? execute.guardrails : [];
  const standardWorkerEnum = resolveStandardWorkerEnum(execute);
  const priorWaveContextCaps = isPlainObject(execute && execute.priorWaveContextCaps)
    ? execute.priorWaveContextCaps
    : null;

  if (Array.isArray(guardrails) && guardrails.length > 0) {
    const ids = guardrails.map((g) => (typeof g === 'string' ? g : g?.id)).filter(Boolean);
    if (ids.length > 0) {
      try {
        const projectRoot = resolveSdlcRoot({ cwd }) || cwd;
        recordGuardrailEvaluationFn(projectRoot, ids);
      } catch (_) {
        // fail-open
      }
    }
  }

  return { guardrails, advisory, standardWorkerEnum, priorWaveContextCaps };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const opts = parseArgs(argv);
  const targetCwd = opts.cwd ? path.resolve(opts.cwd) : undefined;
  const root = resolveSdlcRoot(targetCwd ? { cwd: targetCwd } : undefined) || targetCwd || process.cwd();
  const { guardrails, advisory, standardWorkerEnum, priorWaveContextCaps } = runExecuteContextAdvisory(root);
  if (advisory) process.stderr.write(advisory + '\n');
  if (opts.meta) {
    writeJsonLine({ guardrails, advisory, standardWorkerEnum, priorWaveContextCaps });
    return;
  }
  writeJsonLine(guardrails);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`execute-context-advisory.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, runExecuteContextAdvisory, main };
