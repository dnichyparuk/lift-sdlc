#!/usr/bin/env node
/**
 * received-review-cluster.js
 *
 * Pure deterministic clustering/dedup engine for received-review-sdlc's
 * Step 11.6 (META-ANALYZE). Given the LLM's per-finding verdicts (from
 * Steps 2-4) plus the harden-hint fields already present on the
 * received-review.js manifest, this script performs all of the mechanical
 * work that step used to spell out in prose:
 *
 *   - group findings into clusters keyed by (hardenSurfaceHint, hardenTargetFileHint)
 *   - drop singleton `disagree` findings per targetFile (KD6)
 *   - cap clusters (sort by top severity desc, then finding count desc,
 *     then alphabetic surface/targetFile), tracking suppressed-by-cap count
 *   - scan the last 100 lines of .sdlc/learnings/log.md for prior deferred
 *     clusters and suppress re-run duplicates (KD7)
 *   - synthesize each cluster's failure text (comment bodies + verification
 *     status + verdict, trimmed to 4096 chars) for harden-sdlc dispatch
 *   - resolve which cell of the auto-mode matrix applies (R24) and, for the
 *     auto+defer cell, pre-format the deferred-action log entry
 *
 * The LLM is left only with what a script cannot do: presenting the
 * per-cluster consent gate (ask_question) and dispatching Skill(harden-sdlc).
 *
 * Usage:
 *   node received-review-cluster.js < input.json
 *   node received-review-cluster.js --input-file <path>
 *
 * Input JSON (stdin or --input-file):
 *   {
 *     "projectRoot": "<path>",              // optional, default cwd
 *     "auto": false,
 *     "alwaysHardenFromReview": false,
 *     "hardenClusterCap": 5,
 *     "findings": [
 *       {
 *         "threadId": "...",
 *         "verdict": "agree, will fix" | "agree, won't fix" | "disagree" | "needs discussion",
 *         "severity": "low"|"medium"|"high"|"critical"|null,
 *         "hardenSurfaceHint": "review-dimensions"|"plan-guardrails"|"execute-guardrails"|"copilot-instructions"|null,
 *         "hardenTargetFileHint": "<abs path>"|null,
 *         "body": "<comment body text>",
 *         "verificationStatus": "confirmed"|"confirmed, but suggestion is incomplete"|"incorrect"|"partially correct"|"cannot verify"|null
 *       }
 *     ]
 *   }
 *
 * Exit codes:
 *   0 = success, JSON on stdout
 *   1 = no input provided
 *   2 = script error (malformed input)
 *
 * Stdout: single JSON line — see buildResult() for shape.
 * Stderr: warnings/progress only.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');

const { writeJsonLine } = require(path.join(LIB, 'output'));
const { resolveLogPath } = require(path.join(LIB, 'mcp-failure'));

const FAILURE_TEXT_MAX = 4096;
const RERUN_SCAN_LINES = 100;
// Cluster-key separator between hardenSurfaceHint and hardenTargetFileHint.
// Written as the JS unicode escape sequence (six literal source characters:
// backslash, u, 0, 0, 0, 0) so the source file itself contains no raw NUL byte.
const CLUSTER_KEY_SEP = '\u0000';

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
function severityRank(sev) {
  return SEVERITY_RANK[sev] || 0;
}

const CLUSTERABLE_VERDICTS = new Set([
  'agree, will fix',
  "agree, won't fix",
  'disagree',
  'needs discussion',
]);

// ---------------------------------------------------------------------------
// Step 11.6.1 — cluster findings
// ---------------------------------------------------------------------------

/**
 * Drop singleton `disagree` findings: a `disagree` finding only survives if
 * at least one other `disagree` finding shares its hardenTargetFileHint.
 */
function filterSingletonDisagrees(findings) {
  const disagreeByTarget = new Map();
  for (const f of findings) {
    if (f.verdict !== 'disagree') continue;
    const key = f.hardenTargetFileHint || '';
    if (!disagreeByTarget.has(key)) disagreeByTarget.set(key, []);
    disagreeByTarget.get(key).push(f);
  }
  const droppedIds = new Set();
  for (const [, group] of disagreeByTarget) {
    if (group.length < 2) {
      for (const f of group) droppedIds.add(f.threadId);
    }
  }
  return findings.filter(f => !droppedIds.has(f.threadId));
}

/**
 * Count findings that are otherwise clusterable (verdict-eligible) but are
 * excluded from clustering because they are missing hardenSurfaceHint and/or
 * hardenTargetFileHint. These findings have no cluster key, so they never
 * appear in a cluster — this count is how the caller learns they existed
 * instead of the drop being silent.
 */
function countSkippedNullHints(findings) {
  return findings.filter(
    f => CLUSTERABLE_VERDICTS.has(f.verdict) && (!f.hardenSurfaceHint || !f.hardenTargetFileHint)
  ).length;
}

/**
 * Group eligible findings into clusters keyed by (hardenSurfaceHint, hardenTargetFileHint).
 * Findings missing either hint are not clusterable and are excluded.
 */
function clusterFindings(findings) {
  const eligible = findings.filter(
    f => CLUSTERABLE_VERDICTS.has(f.verdict) && f.hardenSurfaceHint && f.hardenTargetFileHint
  );
  const deduped = filterSingletonDisagrees(eligible);

  const byKey = new Map();
  for (const f of deduped) {
    const key = `${f.hardenSurfaceHint}${CLUSTER_KEY_SEP}${f.hardenTargetFileHint}`;
    if (!byKey.has(key)) {
      byKey.set(key, { surface: f.hardenSurfaceHint, targetFile: f.hardenTargetFileHint, findings: [] });
    }
    byKey.get(key).findings.push(f);
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Step 11.6.1 — cap and sort
// ---------------------------------------------------------------------------

function clusterTopSeverity(cluster) {
  return Math.max(0, ...cluster.findings.map(f => severityRank(f.severity)));
}

/**
 * Sort by top-severity desc -> finding count desc -> alphabetic (surface, targetFile).
 * Apply cap; return { kept, suppressedByCap }.
 */
function capAndSortClusters(clusters, cap) {
  const sorted = [...clusters].sort((a, b) => {
    const sevDiff = clusterTopSeverity(b) - clusterTopSeverity(a);
    if (sevDiff !== 0) return sevDiff;
    const countDiff = b.findings.length - a.findings.length;
    if (countDiff !== 0) return countDiff;
    const surfaceDiff = a.surface.localeCompare(b.surface);
    if (surfaceDiff !== 0) return surfaceDiff;
    return a.targetFile.localeCompare(b.targetFile);
  });
  const kept = sorted.slice(0, cap);
  const suppressedByCap = Math.max(0, sorted.length - cap);
  return { kept, suppressedByCap };
}

// ---------------------------------------------------------------------------
// Step 11.6.2 — re-run guard (KD7)
// ---------------------------------------------------------------------------

/**
 * Scan the tail of the learnings log for prior deferred-cluster entries and
 * return the set of "surface|targetFile" keys already recorded.
 */
function scanRerunKeys(logPath) {
  let text;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch (_) {
    return new Set();
  }
  const lines = text.split('\n');
  const tail = lines.slice(-RERUN_SCAN_LINES).join('\n');
  const keys = new Set();
  const re = /surface=(\S+)\s+targetFile=(\S+)/g;
  let m;
  while ((m = re.exec(tail)) !== null) {
    keys.add(`${m[1]}|${m[2]}`);
  }
  return keys;
}

function applyRerunGuard(clusters, rerunKeys) {
  const kept = [];
  let suppressedByRerun = 0;
  for (const c of clusters) {
    const key = `${c.surface}|${c.targetFile}`;
    if (rerunKeys.has(key)) {
      suppressedByRerun += 1;
    } else {
      kept.push(c);
    }
  }
  return { kept, suppressedByRerun };
}

// ---------------------------------------------------------------------------
// Step 11.6.4 — failure text synthesis
// ---------------------------------------------------------------------------

function synthesizeFailureText(cluster) {
  const parts = cluster.findings.map(f => {
    const pieces = [f.body || '', f.verificationStatus || '', f.verdict || ''];
    return pieces.filter(Boolean).join(' | ');
  });
  const full = parts.join('\n---\n');
  return full.length > FAILURE_TEXT_MAX ? full.slice(0, FAILURE_TEXT_MAX) : full;
}

function verdictMixCsv(cluster) {
  const counts = new Map();
  for (const f of cluster.findings) {
    counts.set(f.verdict, (counts.get(f.verdict) || 0) + 1);
  }
  return [...counts.entries()].map(([v, n]) => `${v}:${n}`).join(',');
}

function finalizeCluster(cluster) {
  const failureText = synthesizeFailureText(cluster);
  return {
    surface: cluster.surface,
    targetFile: cluster.targetFile,
    findingCount: cluster.findings.length,
    findingIds: cluster.findings.map(f => f.threadId),
    verdictMix: verdictMixCsv(cluster),
    topSeverityRank: clusterTopSeverity(cluster),
    failureText,
    preview200: failureText.slice(0, 200),
    preview100: failureText.slice(0, 100),
  };
}

// ---------------------------------------------------------------------------
// Step 11.6.3 — auto-mode matrix
// ---------------------------------------------------------------------------

/**
 * @returns {'interactive-consent'|'interactive-always'|'auto-defer'|'auto-always'}
 */
function resolveMatrixMode(auto, alwaysHardenFromReview) {
  if (!auto && !alwaysHardenFromReview) return 'interactive-consent';
  if (!auto && alwaysHardenFromReview) return 'interactive-always';
  if (auto && !alwaysHardenFromReview) return 'auto-defer';
  return 'auto-always';
}

function formatDeferredLogEntry(prNumber, clusters, suppressedByCap, cap, suppressedByRerun) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const lines = [
    `## ${dateStr} — received-review-sdlc: deferred meta-analysis clusters`,
    `PR: ${prNumber == null ? 'unknown' : prNumber}`,
    `Clusters (${clusters.length}):`,
  ];
  for (const c of clusters) {
    lines.push(
      `- surface=${c.surface} targetFile=${c.targetFile} findings=${c.findingCount} ` +
      `verdict-mix=${c.verdictMix} failure-text-preview="${c.preview100}"`
    );
  }
  lines.push(`Suppressed: ${suppressedByCap} additional clusters beyond cap=${cap}`);
  if (suppressedByRerun > 0) {
    lines.push(`Suppressed: ${suppressedByRerun} clusters by re-run dedup (KD7)`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * @param {object} input  parsed input JSON (see file header)
 * @param {string} [logPath]  override for the learnings log path (tests)
 * @returns {object} result payload (see file header "Stdout")
 */
function buildResult(input, logPath) {
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const projectRoot = input.projectRoot || process.cwd();
  const auto = Boolean(input.auto);
  const alwaysHardenFromReview = Boolean(input.alwaysHardenFromReview);
  const cap = Number.isFinite(input.hardenClusterCap) && input.hardenClusterCap > 0
    ? Math.floor(input.hardenClusterCap)
    : 5;

  const skippedNullHints = countSkippedNullHints(findings);

  const rawClusters = clusterFindings(findings);
  const { kept: capped, suppressedByCap } = capAndSortClusters(rawClusters, cap);

  const resolvedLogPath = logPath || resolveLogPath(projectRoot);
  const rerunKeys = scanRerunKeys(resolvedLogPath);
  const { kept: afterRerun, suppressedByRerun } = applyRerunGuard(capped, rerunKeys);

  const clusters = afterRerun.map(finalizeCluster);
  const mode = resolveMatrixMode(auto, alwaysHardenFromReview);

  const result = {
    mode,
    clusters,
    suppressedByCap,
    suppressedByRerun,
    skippedNullHints,
    deferredLogEntry: null,
  };

  if (mode === 'auto-defer' && clusters.length > 0) {
    result.deferredLogEntry = formatDeferredLogEntry(
      input.prNumber, clusters, suppressedByCap, cap, suppressedByRerun
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let inputFile = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input-file' && argv[i + 1]) inputFile = argv[++i];
  }
  return { inputFile };
}

function main() {
  const { inputFile } = parseArgs(process.argv.slice(2));

  let raw;
  if (inputFile) {
    raw = fs.readFileSync(inputFile, 'utf8');
  } else {
    raw = fs.readFileSync(0, 'utf8');
  }

  if (!raw || !raw.trim()) {
    process.stderr.write('received-review-cluster: no input provided (stdin or --input-file).\n');
    process.exit(1);
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`received-review-cluster: invalid JSON input: ${err.message}\n`);
    process.exit(2);
  }

  const result = buildResult(input);
  writeJsonLine(result);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`received-review-cluster.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = {
  clusterFindings,
  filterSingletonDisagrees,
  countSkippedNullHints,
  capAndSortClusters,
  scanRerunKeys,
  applyRerunGuard,
  synthesizeFailureText,
  verdictMixCsv,
  finalizeCluster,
  resolveMatrixMode,
  formatDeferredLogEntry,
  buildResult,
  parseArgs,
};
