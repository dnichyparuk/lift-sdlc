'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'learn-status.js');
const { getLearnStatus } = require('./learn-status.js');

function createTempProject(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-status-test-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const sdlcDir = path.join(root, '.sdlc');
  fs.mkdirSync(sdlcDir, { recursive: true });

  const config = {
    version: { current: '1.0.0' },
    rejected_guardrails: opts.rejectedGuardrails || [],
  };
  if (opts.learnConfig) {
    config.learn = opts.learnConfig;
  }
  fs.writeFileSync(path.join(sdlcDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');

  if (opts.pendingFiles) {
    const pendingDir = path.join(sdlcDir, 'learnings', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    for (const [filename, content] of Object.entries(opts.pendingFiles)) {
      fs.writeFileSync(path.join(pendingDir, filename), content);
    }
  }

  return root;
}

function makePendingContent(signature, rationale = 'some rationale', evidence = 'some evidence') {
  return [
    '---',
    `signature: ${signature}`,
    `rationale: ${rationale}`,
    `evidence: ${evidence}`,
    '---',
    '',
    'Body text',
  ].join('\n');
}

test('CLI: exits 0 and prints usage on --help and -h', () => {
  for (const flag of ['--help', '-h']) {
    const res = spawnSync(process.execPath, [SCRIPT, flag], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /Usage:/);
    assert.match(res.stdout, /--cwd/);
  }
});

test('learn-status: returns empty zero counts when pending directory does not exist', () => {
  const root = createTempProject();
  const status = getLearnStatus({ cwd: root });

  assert.strictEqual(status.eligibleCount, 0);
  assert.strictEqual(status.waitingCount, 0);
  assert.deepStrictEqual(status.eligibleSignatures, []);
  assert.deepStrictEqual(status.waitingSignatures, []);
  assert.strictEqual(status.threshold, 3);
});

test('learn-status: groups items below threshold into waiting', () => {
  const root = createTempProject({
    pendingFiles: {
      '1-pattern-a.md': makePendingContent('pattern-a', 'r1', 'e1'),
      '2-pattern-a.md': makePendingContent('pattern-a', 'r2', 'e2'),
      '1-pattern-b.md': makePendingContent('pattern-b', 'r1', 'e1'),
    },
  });

  const status = getLearnStatus({ cwd: root });

  assert.strictEqual(status.eligibleCount, 0);
  assert.strictEqual(status.waitingCount, 2);
  assert.deepStrictEqual(status.eligibleSignatures, []);
  assert.ok(status.waitingSignatures.includes('pattern-a'));
  assert.ok(status.waitingSignatures.includes('pattern-b'));
});

test('learn-status: promotes items reaching threshold to eligible', () => {
  const root = createTempProject({
    pendingFiles: {
      '1-pattern-a.md': makePendingContent('pattern-a', 'r1', 'e1'),
      '2-pattern-a.md': makePendingContent('pattern-a', 'r2', 'e2'),
      '3-pattern-a.md': makePendingContent('pattern-a', 'r3', 'e3'),
      '1-pattern-b.md': makePendingContent('pattern-b', 'r1', 'e1'),
    },
  });

  const status = getLearnStatus({ cwd: root });

  assert.strictEqual(status.eligibleCount, 1);
  assert.strictEqual(status.waitingCount, 1);
  assert.deepStrictEqual(status.eligibleSignatures, ['pattern-a']);
  assert.deepStrictEqual(status.waitingSignatures, ['pattern-b']);
});

test('learn-status: respects custom recurrenceThreshold from config', () => {
  const root = createTempProject({
    learnConfig: { recurrenceThreshold: 2 },
    pendingFiles: {
      '1-pattern-a.md': makePendingContent('pattern-a', 'r1', 'e1'),
      '2-pattern-a.md': makePendingContent('pattern-a', 'r2', 'e2'),
    },
  });

  const status = getLearnStatus({ cwd: root });

  assert.strictEqual(status.threshold, 2);
  assert.strictEqual(status.eligibleCount, 1);
  assert.deepStrictEqual(status.eligibleSignatures, ['pattern-a']);
  assert.strictEqual(status.waitingCount, 0);
});

test('Negative cache: filters out signatures in rejected_guardrails from eligible and waiting', () => {
  const root = createTempProject({
    rejectedGuardrails: ['rejected-pattern'],
    pendingFiles: {
      // 3 items for rejected-pattern (would be eligible if not rejected)
      '1-rejected.md': makePendingContent('rejected-pattern', 'r1', 'e1'),
      '2-rejected.md': makePendingContent('rejected-pattern', 'r2', 'e2'),
      '3-rejected.md': makePendingContent('rejected-pattern', 'r3', 'e3'),
      // 1 item for valid-pattern
      '1-valid.md': makePendingContent('valid-pattern', 'r1', 'e1'),
    },
  });

  const status = getLearnStatus({ cwd: root });

  assert.strictEqual(status.eligibleCount, 0);
  assert.ok(!status.eligibleSignatures.includes('rejected-pattern'));
  assert.strictEqual(status.waitingCount, 1);
  assert.deepStrictEqual(status.waitingSignatures, ['valid-pattern']);
});

test('CLI: executes end-to-end and outputs single JSON line', () => {
  const root = createTempProject({
    pendingFiles: {
      '1-test.md': makePendingContent('test-rule', 'r1', 'e1'),
      '2-test.md': makePendingContent('test-rule', 'r2', 'e2'),
      '3-test.md': makePendingContent('test-rule', 'r3', 'e3'),
    },
  });

  const res = spawnSync(process.execPath, [SCRIPT, '--cwd', root], {
    encoding: 'utf8',
  });

  assert.strictEqual(res.status, 0);
  const parsed = JSON.parse(res.stdout.trim());
  assert.strictEqual(parsed.eligibleCount, 1);
  assert.deepStrictEqual(parsed.eligibleSignatures, ['test-rule']);
  assert.strictEqual(parsed.waitingCount, 0);
});
