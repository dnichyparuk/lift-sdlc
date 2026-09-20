'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'capture-learning.js');
const { parsePendingFile } = require('../lib/learnings.js');

function createTempProject(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-learning-test-'));
  const sdlcDir = path.join(root, '.sdlc');
  fs.mkdirSync(sdlcDir, { recursive: true });

  const config = {
    version: { current: '1.0.0' },
    rejected_guardrails: opts.rejectedGuardrails || [],
  };
  fs.writeFileSync(path.join(sdlcDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');

  return root;
}

test('CLI: exits 0 and prints usage on --help and -h', () => {
  for (const flag of ['--help', '-h']) {
    const res = spawnSync(process.execPath, [SCRIPT, flag], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /Usage:/);
    assert.match(res.stdout, /--stdin/);
    assert.match(res.stdout, /--file/);
  }
});

test('CLI: exits 1 when neither --stdin nor --file is specified', () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /Either --stdin or --file <path> must be specified/);
});

test('CLI: exits 1 when --file points to a non-existent file', () => {
  const root = createTempProject();
  const nonExistent = path.join(root, 'missing.json');
  const res = spawnSync(process.execPath, [SCRIPT, '--file', nonExistent], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /File not found/);
});

test('CLI: exits 1 on malformed JSON payload', () => {
  const root = createTempProject();
  const res = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
    cwd: root,
    input: '{ not valid json }',
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /Invalid JSON payload/);
});

test('CLI: exits 1 on non-object JSON payload', () => {
  const root = createTempProject();
  const res = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
    cwd: root,
    input: '["an", "array"]',
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /Payload must be a non-null JSON object/);
});

test('CLI: validates signature format (kebab-case required)', () => {
  const root = createTempProject();
  const invalidSignatures = [
    'Upper-Case',
    'has_underscore',
    '123-leading-digit',
    'trailing-hyphen-',
    'spaces in id',
    '',
  ];

  for (const sig of invalidSignatures) {
    const payload = JSON.stringify({
      signature: sig,
      rationale: 'valid rationale',
      evidence: 'valid evidence',
    });
    const res = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
      cwd: root,
      input: payload,
      encoding: 'utf8',
    });
    assert.strictEqual(res.status, 1, `Expected failure for signature "${sig}"`);
    assert.match(res.stderr, /signature/i);
  }
});

test('CLI: validates rationale and evidence presence and length bounds', () => {
  const root = createTempProject();

  // Missing rationale
  let res = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
    cwd: root,
    input: JSON.stringify({ signature: 'valid-sig', evidence: 'valid evidence' }),
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /rationale/);

  // Rationale exceeds 2000 chars
  res = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
    cwd: root,
    input: JSON.stringify({
      signature: 'valid-sig',
      rationale: 'x'.repeat(2001),
      evidence: 'valid evidence',
    }),
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /exceeds maximum length of 2000/);

  // Missing evidence
  res = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
    cwd: root,
    input: JSON.stringify({ signature: 'valid-sig', rationale: 'valid rationale' }),
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /evidence/);

  // Evidence exceeds 2000 chars
  res = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
    cwd: root,
    input: JSON.stringify({
      signature: 'valid-sig',
      rationale: 'valid rationale',
      evidence: 'e'.repeat(2001),
    }),
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /exceeds maximum length of 2000/);
});

test('CLI: validates impact field restrictions', () => {
  const root = createTempProject();

  // Impact with newline
  let res = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
    cwd: root,
    input: JSON.stringify({
      signature: 'valid-sig',
      rationale: 'valid',
      evidence: 'valid',
      impact: 'line1\nline2',
    }),
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /single line/);

  // Impact with backtick
  res = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
    cwd: root,
    input: JSON.stringify({
      signature: 'valid-sig',
      rationale: 'valid',
      evidence: 'valid',
      impact: 'has `backtick`',
    }),
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /backtick/);

  // Impact exceeds 80 chars
  res = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
    cwd: root,
    input: JSON.stringify({
      signature: 'valid-sig',
      rationale: 'valid',
      evidence: 'valid',
      impact: 'i'.repeat(81),
    }),
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /exceeds maximum length of 80/);
});

test('CLI: captures valid learning via --stdin and generates compliant pending file', () => {
  const root = createTempProject();
  const payload = {
    signature: 'auth-layer-raw-sql',
    rationale: 'Raw SQL string concatenation detected in query assembly.',
    evidence: 'Task 3 failed with SQL syntax error on auth-dao.ts line 42.',
    impact: 'high',
    sourceSkill: 'execute-plan-sdlc',
    sourceRef: 'task-3',
  };

  const res = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });

  assert.strictEqual(res.status, 0, `Capture failed: ${res.stderr}`);
  assert.match(res.stdout, /\[learning-capture\] Captured pending learning:/);

  const pendingDir = path.join(root, '.sdlc', 'learnings', 'pending');
  const files = fs.readdirSync(pendingDir);
  assert.strictEqual(files.length, 1);
  assert.match(files[0], /auth-layer-raw-sql\.md$/);

  const filePath = path.join(pendingDir, files[0]);
  const content = fs.readFileSync(filePath, 'utf8');

  // Verify it parses cleanly with parsePendingFile from lib/learnings.js
  const parsed = parsePendingFile(content, filePath);
  assert.strictEqual(parsed.valid, true, `parsePendingFile failed: ${parsed.reason}`);
  assert.strictEqual(parsed.signature, 'auth-layer-raw-sql');
  assert.strictEqual(parsed.rationale, payload.rationale);
  assert.strictEqual(parsed.evidence, payload.evidence);
  assert.strictEqual(parsed.impact, 'high');
});

test('CLI: captures valid learning via --file flag', () => {
  const root = createTempProject();
  const jsonPath = path.join(root, 'payload.json');
  fs.writeFileSync(jsonPath, JSON.stringify({
    signature: 'missing-boundary-validation',
    rationale: 'Controller missed input parameter validation.',
    evidence: 'Reviewer comment on PR #12 highlighted unvalidated payload.',
    sourceSkill: 'received-review-sdlc',
  }));

  const res = spawnSync(process.execPath, [SCRIPT, '--file', jsonPath], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.strictEqual(res.status, 0, `Capture via --file failed: ${res.stderr}`);
  assert.match(res.stdout, /\[learning-capture\] Captured pending learning:/);

  const pendingDir = path.join(root, '.sdlc', 'learnings', 'pending');
  const files = fs.readdirSync(pendingDir);
  assert.strictEqual(files.length, 1);
  assert.match(files[0], /missing-boundary-validation\.md$/);
});

test('Negative cache: exits 0 and suppresses write when signature is in rejected_guardrails', () => {
  const root = createTempProject({
    rejectedGuardrails: ['suppressed-anti-pattern', 'another-rejected-sig'],
  });

  const payload = {
    signature: 'suppressed-anti-pattern',
    rationale: 'Rejected proposal that was tried before.',
    evidence: 'Attempted to generate rule, but human rejected PR.',
  };

  const res = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });

  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /\[learning-capture\] Suppressed: signature 'suppressed-anti-pattern' is in rejected_guardrails/);

  const pendingDir = path.join(root, '.sdlc', 'learnings', 'pending');
  if (fs.existsSync(pendingDir)) {
    const files = fs.readdirSync(pendingDir);
    assert.strictEqual(files.length, 0, 'No pending files should be written for rejected signature');
  }
});

test('Directory cap: exits 0 and refuses to write when pending directory has >= 100 files', () => {
  const root = createTempProject();
  const pendingDir = path.join(root, '.sdlc', 'learnings', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });

  // Pre-fill 100 dummy files
  for (let i = 0; i < 100; i++) {
    fs.writeFileSync(path.join(pendingDir, `prefill-${i}.md`), 'dummy');
  }

  const payload = {
    signature: 'new-learning-sig',
    rationale: 'Some rationale',
    evidence: 'Some evidence',
  };

  const res = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });

  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /Warning: pending directory cap reached \(>= 100 files\)\. Skipping capture\./);

  const files = fs.readdirSync(pendingDir);
  assert.strictEqual(files.length, 100, 'Cap must prevent creating additional files');
});

test('Deduplication: skips writing duplicate pending learning for identical signature and content', () => {
  const root = createTempProject();
  const payload = {
    signature: 'dedup-test-signature',
    rationale: 'Repeated rationale',
    evidence: 'Repeated evidence',
  };

  // First capture
  const res1 = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  assert.strictEqual(res1.status, 0);
  assert.match(res1.stdout, /Captured pending learning/);

  // Second capture with exact same content
  const res2 = spawnSync(process.execPath, [SCRIPT, '--stdin'], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  assert.strictEqual(res2.status, 0);
  assert.match(res2.stdout, /Skipped: duplicate pending learning exists for signature 'dedup-test-signature'/);

  const pendingDir = path.join(root, '.sdlc', 'learnings', 'pending');
  const files = fs.readdirSync(pendingDir);
  assert.strictEqual(files.length, 1, 'Only one file should exist after duplicate attempt');
});
