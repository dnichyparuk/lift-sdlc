#!/usr/bin/env node
/**
 * verify-pipeline.js
 *
 * Inline-execution polling script for the ship-sdlc `verify-pipeline` step.
 * Polls `gh pr checks <N> --json ...` at a configurable interval until all
 * required checks have non-pending conclusions, or a timeout elapses.
 *
 * Implements R41-R44, R47-R49 of docs/specs/ship-sdlc.md.
 *
 * Usage:
 *   node verify-pipeline.js [--pr <number>] [--timeout <s>] [--interval <s>] [--state-file <path>]
 *
 * Stdout: exactly ONE JSON line, one of:
 *   {"status":"green","prNumber":N}
 *   {"status":"failed","prNumber":N,"failedChecks":[{name,conclusion,logsExcerpt}]}
 *   {"status":"timeout","waitedSeconds":N,"prNumber":N}
 *   {"status":"skipped","reason":"exhausted","prNumber":N}
 *   {"status":"error","reason":"..."}
 *
 * Stderr: progress logs.
 *
 * Sleep is via Atomics.wait — no subprocess. (R47, kiss/dry)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');

const { fetchPrMetadata, fetchPrChecks, fetchFailedCheckLogs } = require(path.join(LIB, 'git'));
const { writeJsonLine } = require(path.join(LIB, 'output'));

// ---------------------------------------------------------------------------
// Pure helper (exported for tests) — implements R42/R43 verdict mapping
// ---------------------------------------------------------------------------

/**
 * Map a `gh pr checks` JSON array to a verdict.
 *
 * - Any `bucket === 'fail'` → `failed`
 * - Any `bucket === 'pending'` → `pending`
 * - Empty array → `green` (vacuous pass — no checks configured)
 * - Otherwise → `green`
 *
 * @param {Array<{name:string,bucket:string,link?:string}>} checks
 * @returns {{status:'green'|'failed'|'pending', failed:Array, pending:Array}}
 */
function evaluateChecks(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const failed = list.filter((c) => c && c.bucket === 'fail');
  const pending = list.filter((c) => c && c.bucket === 'pending');
  let status = 'green';
  if (failed.length > 0) status = 'failed';
  else if (pending.length > 0) status = 'pending';
  return { status, failed, pending };
}

// ---------------------------------------------------------------------------
// Argument parsing (hand-rolled to match sibling scripts)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    pr: null,
    timeout: 1200,
    interval: 60,
    stateFile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') out.pr = argv[++i];
    else if (a === '--timeout') out.timeout = parseInt(argv[++i], 10);
    else if (a === '--interval') out.interval = parseInt(argv[++i], 10);
    else if (a === '--state-file') out.stateFile = argv[++i];
  }
  if (!Number.isFinite(out.timeout) || out.timeout < 1) out.timeout = 1200;
  if (!Number.isFinite(out.interval) || out.interval < 1) out.interval = 60;
  return out;
}

// ---------------------------------------------------------------------------
// State-file marker helpers (R49)
// ---------------------------------------------------------------------------

function readStateFile(p) {
  if (!p) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function writeStateMarker(p, key, value) {
  if (!p) return;
  let state = readStateFile(p);
  if (!state || typeof state !== 'object') state = {};
  state[key] = value;
  try {
    fs.writeFileSync(p, JSON.stringify(state, null, 2));
  } catch (err) {
    process.stderr.write(`verify-pipeline: failed to write state marker: ${err.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Sleep via Atomics.wait — reuses the lib/git.js retryExec primitive
// (no setTimeout/setInterval/sleep subprocess; R47, scripts-over-llm-logic)
// ---------------------------------------------------------------------------

function sleepMs(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Run-id extraction from `gh pr checks` `link` field
// link format: https://github.com/<owner>/<repo>/actions/runs/<runId>/job/<jobId>
// ---------------------------------------------------------------------------

function extractRunId(link) {
  if (!link || typeof link !== 'string') return null;
  const m = link.match(/\/actions\/runs\/(\d+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Single-line stdout emitter
// ---------------------------------------------------------------------------

// emit() is a thin alias over `lib/output.js::writeJsonLine` (issue #284,
// task 3). Each call site emits ONE verdict and returns from main();
// writeJsonLine exits with code 0, matching the previous post-return exit.
function emit(verdict) {
  writeJsonLine(verdict);
}

// ---------------------------------------------------------------------------
// Main (CLI entry — runs only on require.main === module)
// ---------------------------------------------------------------------------

function main(argv) {
  const args = parseArgs(argv);

  // R49: short-circuit on state-marker
  if (args.stateFile) {
    const state = readStateFile(args.stateFile);
    if (state && state.verifyPipelineExhausted === true) {
      emit({ status: 'skipped', reason: 'exhausted', prNumber: args.pr ? Number(args.pr) : null });
      return;
    }
  }

  // Resolve PR number — fall back to current branch metadata
  let prNumber = args.pr ? Number(args.pr) : null;
  if (!prNumber) {
    const meta = fetchPrMetadata();
    if (!meta || !meta.exists || !meta.number) {
      emit({ status: 'error', reason: 'no PR found for current branch (gh pr view failed)' });
      return;
    }
    prNumber = meta.number;
  }

  const startedAt = Date.now();
  const timeoutMs = args.timeout * 1000;
  const intervalMs = args.interval * 1000;
  let iteration = 0;

  // Polling loop — R42
  while (Date.now() - startedAt < timeoutMs) {
    iteration += 1;
    process.stderr.write(`verify-pipeline: poll ${iteration} (PR #${prNumber})\n`);
    const { checks, ghAuthenticated, errorMessage } = fetchPrChecks(prNumber);
    if (!ghAuthenticated) {
      emit({ status: 'error', reason: errorMessage });
      return;
    }
    const verdict = evaluateChecks(checks);

    if (verdict.status === 'green') {
      emit({ status: 'green', prNumber });
      return;
    }

    if (verdict.status === 'failed') {
      // R44: fetch log excerpts for each failed check
      const failedChecks = verdict.failed.map((c) => {
        const runId = extractRunId(c.link);
        let logsExcerpt = '';
        if (runId) {
          const logs = fetchFailedCheckLogs(runId, { maxLines: 200 });
          if (logs && logs.ok) logsExcerpt = logs.excerpt;
        }
        return {
          name: c.name,
          conclusion: c.bucket || c.state || 'fail',
          logsExcerpt,
        };
      });
      emit({ status: 'failed', prNumber, failedChecks });
      return;
    }

    // Pending — sleep and retry
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    const waitMs = Math.min(intervalMs, Math.max(0, remainingMs));
    if (waitMs <= 0) break;
    sleepMs(waitMs);
  }

  // R48: timeout
  const waitedSeconds = Math.floor((Date.now() - startedAt) / 1000);
  if (args.stateFile) writeStateMarker(args.stateFile, 'verifyPipelineExhausted', true);
  emit({ status: 'timeout', waitedSeconds, prNumber });
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    emit({ status: 'error', reason: err && err.message ? err.message : String(err) });
  }
}

module.exports = { evaluateChecks, extractRunId };
