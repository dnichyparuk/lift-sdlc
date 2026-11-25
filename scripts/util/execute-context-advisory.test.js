'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'execute-context-advisory.js');
const { runExecuteContextAdvisory, parseArgs } = require('./execute-context-advisory');

test('parseArgs: accepts no flags', () => {
  assert.deepEqual(parseArgs(['node', 'execute-context-advisory.js']), {});
});

test('runExecuteContextAdvisory: success path — guardrails present, no advisory', () => {
  const readSectionFn = (cwd, section) => {
    assert.equal(cwd, '/repo');
    assert.equal(section, 'execute');
    return { guardrails: ['no-force-push', 'no-secrets'] };
  };
  const getAdvisoryFn = (opts) => {
    assert.deepEqual(opts, { skill: 'execute-plan-sdlc' });
    return null;
  };

  const result = runExecuteContextAdvisory('/repo', { readSectionFn, getAdvisoryFn });

  assert.deepEqual(result.guardrails, ['no-force-push', 'no-secrets']);
  assert.equal(result.advisory, null);
});

test('runExecuteContextAdvisory: success path — advisory text returned when transcript is heavy', () => {
  const readSectionFn = () => ({ guardrails: [] });
  const getAdvisoryFn = () => 'Context advisory: transcript at 82% of model budget.';

  const result = runExecuteContextAdvisory('/repo', { readSectionFn, getAdvisoryFn });

  assert.deepEqual(result.guardrails, []);
  assert.match(result.advisory, /Context advisory/);
});

test('runExecuteContextAdvisory: defaults guardrails to [] when execute section is null', () => {
  const readSectionFn = () => null;
  const getAdvisoryFn = () => null;

  const result = runExecuteContextAdvisory('/repo', { readSectionFn, getAdvisoryFn });

  assert.deepEqual(result.guardrails, []);
});

test('runExecuteContextAdvisory: error path — getAdvisory throw is swallowed (mirrors context_advisory.sh:8-16)', () => {
  const readSectionFn = () => ({ guardrails: ['g1'] });
  const getAdvisoryFn = () => {
    throw new Error('sidecar unreadable');
  };

  const result = runExecuteContextAdvisory('/repo', { readSectionFn, getAdvisoryFn });

  assert.deepEqual(result.guardrails, ['g1']);
  assert.equal(result.advisory, null);
});

test('runExecuteContextAdvisory: error path — a readSectionFn throw is NOT swallowed (propagates for the outer crash handler)', () => {
  const readSectionFn = () => {
    throw new Error('config.js missing (broken plugin install)');
  };
  const getAdvisoryFn = () => null;

  assert.throws(
    () => runExecuteContextAdvisory('/repo', { readSectionFn, getAdvisoryFn }),
    /config\.js missing/
  );
});

test('runExecuteContextAdvisory: records evaluation timestamps for present guardrails', () => {
  const recorded = [];
  const readSectionFn = () => ({
    guardrails: [{ id: 'rule-x' }, 'rule-y', { id: '' }],
  });
  const getAdvisoryFn = () => null;
  const recordGuardrailEvaluationFn = (cwd, ids) => {
    recorded.push({ cwd, ids });
  };

  const result = runExecuteContextAdvisory('/repo', {
    readSectionFn,
    getAdvisoryFn,
    recordGuardrailEvaluationFn,
  });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].cwd, '/repo');
  assert.deepEqual(recorded[0].ids, ['rule-x', 'rule-y']);
  assert.equal(result.guardrails.length, 3);
});

test('parseArgs: parses --meta and --cwd without breaking empty invocation', () => {
  assert.deepEqual(parseArgs(['node', 'execute-context-advisory.js', '--meta']), { meta: true });
  assert.deepEqual(
    parseArgs(['node', 'execute-context-advisory.js', '--meta', '--cwd', '/tmp/proj']),
    { meta: true, cwd: '/tmp/proj' }
  );
  assert.deepEqual(
    parseArgs(['node', 'execute-context-advisory.js', '--cwd=/tmp/proj']),
    { cwd: '/tmp/proj' }
  );
  assert.throws(
    () => parseArgs(['node', 'execute-context-advisory.js', '--meta', '--cwd']),
    /--cwd requires a directory path argument/
  );
});

test('runExecuteContextAdvisory: resolves standardWorkerEnum (defaulting invalid/unset to "pro") and priorWaveContextCaps', () => {
  const inheritRes = runExecuteContextAdvisory('/repo', {
    readSectionFn: () => ({
      guardrails: [],
      standardWorkerEnum: 'inherit',
      priorWaveContextCaps: { maxFiles: 12, maxDecisions: 10 },
    }),
    getAdvisoryFn: () => null,
  });
  assert.equal(inheritRes.standardWorkerEnum, 'inherit');
  assert.deepEqual(inheritRes.priorWaveContextCaps, { maxFiles: 12, maxDecisions: 10 });

  const invalidRes = runExecuteContextAdvisory('/repo', {
    readSectionFn: () => ({
      guardrails: [],
      standardWorkerEnum: 'flash',
      priorWaveContextCaps: 'not-an-object',
    }),
    getAdvisoryFn: () => null,
  });
  assert.equal(invalidRes.standardWorkerEnum, 'pro');
  assert.equal(invalidRes.priorWaveContextCaps, null);

  const emptyRes = runExecuteContextAdvisory('/repo', {
    readSectionFn: () => null,
    getAdvisoryFn: () => null,
  });
  assert.equal(emptyRes.standardWorkerEnum, 'pro');
  assert.equal(emptyRes.priorWaveContextCaps, null);
});

test('CLI: without --meta preserves raw guardrails JSON array stdout; with --meta returns merged local over project config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eca-meta-test-'));
  const tmpEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eca-sidecar-'));
  try {
    const sdlcDir = path.join(root, '.sdlc');
    fs.mkdirSync(sdlcDir, { recursive: true });
    const guardrails = [{ id: 'no-raw-sql', description: 'Use parameterized SQL', severity: 'error' }];
    fs.writeFileSync(
      path.join(sdlcDir, 'config.json'),
      JSON.stringify({
        schemaVersion: 4,
        execute: {
          guardrails,
          standardWorkerEnum: 'pro',
          priorWaveContextCaps: { maxFiles: 20, maxDecisions: 10, maxInterfaces: 15 },
        },
      }, null, 2) + '\n'
    );
    fs.writeFileSync(
      path.join(sdlcDir, 'local.json'),
      JSON.stringify({
        schemaVersion: 4,
        execute: {
          standardWorkerEnum: 'inherit',
          priorWaveContextCaps: { maxFiles: 12 },
        },
      }, null, 2) + '\n'
    );

    const legacyRes = spawnSync(process.execPath, [SCRIPT, '--cwd', root], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: tmpEnvDir, SDLC_CONFIG_QUIET: '1' },
    });
    assert.equal(legacyRes.status, 0, legacyRes.stderr);
    assert.deepEqual(JSON.parse(legacyRes.stdout.trim()), guardrails);

    const metaRes = spawnSync(process.execPath, [SCRIPT, '--meta', '--cwd', root], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: tmpEnvDir, SDLC_CONFIG_QUIET: '1' },
    });
    assert.equal(metaRes.status, 0, metaRes.stderr);
    assert.deepEqual(JSON.parse(metaRes.stdout.trim()), {
      guardrails,
      advisory: null,
      standardWorkerEnum: 'inherit',
      priorWaveContextCaps: { maxFiles: 12, maxDecisions: 10, maxInterfaces: 15 },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpEnvDir, { recursive: true, force: true });
  }
});

test('CLI: --meta defaults gracefully when .sdlc config is absent and includes heavy advisory when present', () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eca-empty-'));
  const tmpEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eca-heavy-'));
  try {
    fs.writeFileSync(
      path.join(tmpEnvDir, 'sdlc-context-stats.json'),
      JSON.stringify({ heavy: true, percent: 78, tokensApprox: 156000 })
    );
    const res = spawnSync(process.execPath, [SCRIPT, '--meta', '--cwd', emptyRoot], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: tmpEnvDir, SDLC_CONFIG_QUIET: '1' },
    });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout.trim());
    assert.deepEqual(parsed.guardrails, []);
    assert.equal(parsed.standardWorkerEnum, 'pro');
    assert.equal(parsed.priorWaveContextCaps, null);
    assert.match(parsed.advisory, /Context advisory: transcript at 78%/);
    assert.match(res.stderr, /Context advisory: transcript at 78%/);
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
    fs.rmSync(tmpEnvDir, { recursive: true, force: true });
  }
});
