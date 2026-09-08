'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  clusterFindings,
  filterSingletonDisagrees,
  countSkippedNullHints,
  capAndSortClusters,
  scanRerunKeys,
  applyRerunGuard,
  synthesizeFailureText,
  verdictMixCsv,
  resolveMatrixMode,
  formatDeferredLogEntry,
  buildResult,
} = require('./received-review-cluster');

function finding(overrides) {
  return {
    threadId: 't1',
    verdict: 'agree, will fix',
    severity: null,
    hardenSurfaceHint: 'plan-guardrails',
    hardenTargetFileHint: '/repo/plan.js',
    body: 'some body',
    verificationStatus: 'confirmed',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// filterSingletonDisagrees
// ---------------------------------------------------------------------------

test('filterSingletonDisagrees: drops a lone disagree per targetFile', () => {
  const findings = [
    finding({ threadId: 'a', verdict: 'disagree', hardenTargetFileHint: '/x.js' }),
    finding({ threadId: 'b', verdict: 'agree, will fix', hardenTargetFileHint: '/x.js' }),
  ];
  const result = filterSingletonDisagrees(findings);
  assert.deepStrictEqual(result.map(f => f.threadId), ['b']);
});

test('filterSingletonDisagrees: keeps disagrees when >=2 share a targetFile', () => {
  const findings = [
    finding({ threadId: 'a', verdict: 'disagree', hardenTargetFileHint: '/x.js' }),
    finding({ threadId: 'b', verdict: 'disagree', hardenTargetFileHint: '/x.js' }),
  ];
  const result = filterSingletonDisagrees(findings);
  assert.deepStrictEqual(result.map(f => f.threadId).sort(), ['a', 'b']);
});

test('filterSingletonDisagrees: does not touch non-disagree verdicts', () => {
  const findings = [
    finding({ threadId: 'a', verdict: 'agree, will fix' }),
  ];
  const result = filterSingletonDisagrees(findings);
  assert.strictEqual(result.length, 1);
});

// ---------------------------------------------------------------------------
// clusterFindings
// ---------------------------------------------------------------------------

test('clusterFindings: groups by (surface, targetFile) tuple', () => {
  const findings = [
    finding({ threadId: 'a' }),
    finding({ threadId: 'b' }),
    finding({ threadId: 'c', hardenTargetFileHint: '/other.js' }),
  ];
  const clusters = clusterFindings(findings);
  assert.strictEqual(clusters.length, 2);
  const c1 = clusters.find(c => c.targetFile === '/repo/plan.js');
  assert.strictEqual(c1.findings.length, 2);
});

test('clusterFindings: excludes findings missing either hint', () => {
  const findings = [
    finding({ threadId: 'a', hardenSurfaceHint: null }),
    finding({ threadId: 'b', hardenTargetFileHint: null }),
    finding({ threadId: 'c' }),
  ];
  const clusters = clusterFindings(findings);
  assert.strictEqual(clusters.length, 1);
  assert.strictEqual(clusters[0].findings.length, 1);
  assert.strictEqual(clusters[0].findings[0].threadId, 'c');
});

test('clusterFindings: excludes pre-Step-4 verdicts (cannot-verify / ungraded)', () => {
  const findings = [
    finding({ threadId: 'a', verdict: 'cannot verify' }),
    finding({ threadId: 'b', verdict: null }),
    finding({ threadId: 'c' }),
  ];
  const clusters = clusterFindings(findings);
  assert.strictEqual(clusters.length, 1);
  assert.strictEqual(clusters[0].findings.length, 1);
});

// ---------------------------------------------------------------------------
// capAndSortClusters
// ---------------------------------------------------------------------------

test('capAndSortClusters: sorts by top severity desc, then count desc, then alpha', () => {
  const clusters = [
    { surface: 'z-surface', targetFile: '/z.js', findings: [finding({ severity: 'low' })] },
    { surface: 'a-surface', targetFile: '/a.js', findings: [finding({ severity: 'critical' })] },
    { surface: 'm-surface', targetFile: '/m.js', findings: [finding({ severity: 'medium' }), finding({ severity: 'medium' })] },
  ];
  const { kept } = capAndSortClusters(clusters, 5);
  assert.deepStrictEqual(kept.map(c => c.surface), ['a-surface', 'm-surface', 'z-surface']);
});

test('capAndSortClusters: applies cap and reports suppressed count', () => {
  const clusters = Array.from({ length: 7 }, (_, i) => ({
    surface: `s${i}`, targetFile: `/f${i}.js`, findings: [finding({ severity: 'low' })],
  }));
  const { kept, suppressedByCap } = capAndSortClusters(clusters, 5);
  assert.strictEqual(kept.length, 5);
  assert.strictEqual(suppressedByCap, 2);
});

// ---------------------------------------------------------------------------
// scanRerunKeys / applyRerunGuard
// ---------------------------------------------------------------------------

test('scanRerunKeys: extracts surface/targetFile pairs from log tail', () => {
  const tmp = path.join(os.tmpdir(), `rr-cluster-test-${Date.now()}.md`);
  fs.writeFileSync(tmp,
    '## 2026-01-01 — received-review-sdlc: deferred meta-analysis clusters\n' +
    'PR: 1\n' +
    'Clusters (1):\n' +
    '- surface=plan-guardrails targetFile=/repo/plan.js findings=2 verdict-mix=disagree:2 failure-text-preview="x"\n'
  );
  try {
    const keys = scanRerunKeys(tmp);
    assert.ok(keys.has('plan-guardrails|/repo/plan.js'));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('scanRerunKeys: returns empty set when log file does not exist', () => {
  const keys = scanRerunKeys('/nonexistent/path/log.md');
  assert.strictEqual(keys.size, 0);
});

test('applyRerunGuard: suppresses clusters whose key was already logged', () => {
  const clusters = [
    { surface: 'a', targetFile: '/a.js', findings: [] },
    { surface: 'b', targetFile: '/b.js', findings: [] },
  ];
  const rerunKeys = new Set(['a|/a.js']);
  const { kept, suppressedByRerun } = applyRerunGuard(clusters, rerunKeys);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].surface, 'b');
  assert.strictEqual(suppressedByRerun, 1);
});

// ---------------------------------------------------------------------------
// synthesizeFailureText / verdictMixCsv
// ---------------------------------------------------------------------------

test('synthesizeFailureText: truncates to 4096 chars', () => {
  const longBody = 'x'.repeat(5000);
  const cluster = { findings: [finding({ body: longBody })] };
  const text = synthesizeFailureText(cluster);
  assert.strictEqual(text.length, 4096);
});

test('synthesizeFailureText: joins multiple findings', () => {
  const cluster = { findings: [finding({ body: 'first' }), finding({ body: 'second' })] };
  const text = synthesizeFailureText(cluster);
  assert.match(text, /first/);
  assert.match(text, /second/);
});

test('verdictMixCsv: counts verdicts as csv', () => {
  const cluster = {
    findings: [
      finding({ verdict: 'disagree' }),
      finding({ verdict: 'disagree' }),
      finding({ verdict: 'agree, will fix' }),
    ],
  };
  const csv = verdictMixCsv(cluster);
  assert.match(csv, /disagree:2/);
  assert.match(csv, /agree, will fix:1/);
});

// ---------------------------------------------------------------------------
// resolveMatrixMode — all four cells
// ---------------------------------------------------------------------------

test('resolveMatrixMode: cell 1 — interactive, per-cluster consent', () => {
  assert.strictEqual(resolveMatrixMode(false, false), 'interactive-consent');
});

test('resolveMatrixMode: cell 2 — interactive, always-harden', () => {
  assert.strictEqual(resolveMatrixMode(false, true), 'interactive-always');
});

test('resolveMatrixMode: cell 3 — auto, defer', () => {
  assert.strictEqual(resolveMatrixMode(true, false), 'auto-defer');
});

test('resolveMatrixMode: cell 4 — auto, always-harden', () => {
  assert.strictEqual(resolveMatrixMode(true, true), 'auto-always');
});

// ---------------------------------------------------------------------------
// formatDeferredLogEntry
// ---------------------------------------------------------------------------

test('formatDeferredLogEntry: includes PR, cluster lines, and suppressed count', () => {
  const clusters = [
    { surface: 'plan-guardrails', targetFile: '/repo/plan.js', findingCount: 2, verdictMix: 'disagree:2', preview100: 'preview' },
  ];
  const entry = formatDeferredLogEntry(42, clusters, 3, 5);
  assert.match(entry, /received-review-sdlc: deferred meta-analysis clusters/);
  assert.match(entry, /PR: 42/);
  assert.match(entry, /surface=plan-guardrails targetFile=\/repo\/plan\.js findings=2 verdict-mix=disagree:2/);
  assert.match(entry, /Suppressed: 3 additional clusters beyond cap=5/);
});

test('formatDeferredLogEntry: appends the KD7 re-run dedup audit line when suppressedByRerun > 0', () => {
  const clusters = [
    { surface: 'plan-guardrails', targetFile: '/repo/plan.js', findingCount: 2, verdictMix: 'disagree:2', preview100: 'preview' },
  ];
  const entry = formatDeferredLogEntry(42, clusters, 0, 5, 4);
  assert.match(entry, /Suppressed: 4 clusters by re-run dedup \(KD7\)/);
});

test('formatDeferredLogEntry: omits the KD7 re-run dedup audit line when suppressedByRerun is 0', () => {
  const clusters = [
    { surface: 'plan-guardrails', targetFile: '/repo/plan.js', findingCount: 2, verdictMix: 'disagree:2', preview100: 'preview' },
  ];
  const entry = formatDeferredLogEntry(42, clusters, 0, 5, 0);
  assert.ok(!/re-run dedup \(KD7\)/.test(entry), 'KD7 line must be absent when nothing was suppressed by the re-run guard');
});

// ---------------------------------------------------------------------------
// countSkippedNullHints — null-hint findings are counted, not silently dropped
// ---------------------------------------------------------------------------

test('countSkippedNullHints: counts clusterable findings missing either harden hint', () => {
  const findings = [
    // Clusterable + both hints -> not skipped.
    { threadId: 'a', verdict: 'disagree', hardenSurfaceHint: 'plan-guardrails', hardenTargetFileHint: '/repo/a.js' },
    // Clusterable but missing target file hint -> skipped.
    { threadId: 'b', verdict: 'disagree', hardenSurfaceHint: 'plan-guardrails', hardenTargetFileHint: null },
    // Clusterable but missing surface hint -> skipped.
    { threadId: 'c', verdict: 'disagree', hardenSurfaceHint: null, hardenTargetFileHint: '/repo/c.js' },
    // Clusterable but missing both -> skipped.
    { threadId: 'd', verdict: 'disagree', hardenSurfaceHint: null, hardenTargetFileHint: null },
  ];
  assert.strictEqual(countSkippedNullHints(findings), 3);
});

test('countSkippedNullHints: ignores findings whose verdict is not clusterable', () => {
  const findings = [
    { threadId: 'x', verdict: 'agree', hardenSurfaceHint: null, hardenTargetFileHint: null },
  ];
  assert.strictEqual(countSkippedNullHints(findings), 0);
});

// ---------------------------------------------------------------------------
// buildResult — end-to-end
// ---------------------------------------------------------------------------

test('buildResult: end-to-end auto-defer produces deferredLogEntry', () => {
  const tmp = path.join(os.tmpdir(), `rr-cluster-e2e-${Date.now()}.md`);
  fs.writeFileSync(tmp, '');
  try {
    const input = {
      prNumber: 7,
      auto: true,
      alwaysHardenFromReview: false,
      hardenClusterCap: 5,
      findings: [finding({ threadId: 'a' }), finding({ threadId: 'b' })],
    };
    const result = buildResult(input, tmp);
    assert.strictEqual(result.mode, 'auto-defer');
    assert.strictEqual(result.clusters.length, 1);
    assert.strictEqual(result.clusters[0].findingCount, 2);
    assert.ok(result.deferredLogEntry);
    assert.match(result.deferredLogEntry, /PR: 7/);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('buildResult: interactive-consent mode has no deferredLogEntry', () => {
  const tmp = path.join(os.tmpdir(), `rr-cluster-e2e2-${Date.now()}.md`);
  fs.writeFileSync(tmp, '');
  try {
    const input = {
      auto: false,
      alwaysHardenFromReview: false,
      findings: [finding({ threadId: 'a' })],
    };
    const result = buildResult(input, tmp);
    assert.strictEqual(result.mode, 'interactive-consent');
    assert.strictEqual(result.deferredLogEntry, null);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('buildResult: re-run guard suppresses a cluster already logged', () => {
  const tmp = path.join(os.tmpdir(), `rr-cluster-e2e3-${Date.now()}.md`);
  fs.writeFileSync(tmp,
    '- surface=plan-guardrails targetFile=/repo/plan.js findings=1 verdict-mix=x failure-text-preview="y"\n'
  );
  try {
    const input = {
      auto: false,
      alwaysHardenFromReview: false,
      findings: [finding({ threadId: 'a' })],
    };
    const result = buildResult(input, tmp);
    assert.strictEqual(result.clusters.length, 0);
    assert.strictEqual(result.suppressedByRerun, 1);
  } finally {
    fs.unlinkSync(tmp);
  }
});
