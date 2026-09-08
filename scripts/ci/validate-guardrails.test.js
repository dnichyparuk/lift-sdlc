'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const {
  validateGuardrailsConfig,
  validateGuardrailsSection,
} = require('./validate-guardrails');

const SCRIPT = path.join(__dirname, 'validate-guardrails.js');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'validate-guardrails-'));
}

/** Write a full `.sdlc/config.json`-shaped file under a fresh tmp project dir. */
function makeProjectRoot(config) {
  const root = makeTmpDir();
  fs.mkdirSync(path.join(root, '.sdlc'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sdlc', 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  return root;
}

/** Write a standalone JSON file (e.g. a `.harden-tmp` staging copy) for --config-file mode. */
function makeConfigFile(config) {
  const dir = makeTmpDir();
  const file = path.join(dir, 'config.json.harden-tmp');
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
  return file;
}

const VALID_GUARDRAIL = {
  id: 'no-force-push',
  description: 'Never force-push to a shared branch.',
  severity: 'error',
};

const INVALID_GUARDRAIL = {
  // missing id
  description: 'Bad guardrail.',
};

// ---------------------------------------------------------------------------
// validateGuardrailsSection — pure validation over an already-resolved value
// ---------------------------------------------------------------------------

test('validateGuardrailsSection returns zero counts for a null section', () => {
  const result = validateGuardrailsSection(null, 'plan');
  assert.deepStrictEqual(result, { errors: [], warnings: [], guardrailCount: 0 });
});

test('validateGuardrailsSection returns zero counts when guardrails is not an array', () => {
  const result = validateGuardrailsSection({ guardrails: 'nope' }, 'plan');
  assert.deepStrictEqual(result, { errors: [], warnings: [], guardrailCount: 0 });
});

test('validateGuardrailsSection passes a well-formed guardrail list', () => {
  const result = validateGuardrailsSection({ guardrails: [VALID_GUARDRAIL] }, 'plan');
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.guardrailCount, 1);
});

test('validateGuardrailsSection collects errors for an invalid guardrail', () => {
  const result = validateGuardrailsSection({ guardrails: [INVALID_GUARDRAIL] }, 'plan');
  assert.strictEqual(result.guardrailCount, 1);
  assert.ok(result.errors.some((e) => e.includes('id is missing')));
});

test('validateGuardrailsSection flags duplicate ids across guardrails', () => {
  const result = validateGuardrailsSection(
    { guardrails: [VALID_GUARDRAIL, { ...VALID_GUARDRAIL }] },
    'plan'
  );
  assert.ok(result.errors.some((e) => e.includes('id is duplicated across guardrails')));
});

// ---------------------------------------------------------------------------
// validateGuardrailsConfig — unchanged project-root + readSection signature
// ---------------------------------------------------------------------------

test('validateGuardrailsConfig reads guardrails via project-root + readSection', () => {
  const root = makeProjectRoot({ plan: { guardrails: [VALID_GUARDRAIL] } });
  const result = validateGuardrailsConfig(root, 'plan');
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.guardrailCount, 1);
});

test('validateGuardrailsConfig returns zero counts when .sdlc/config.json does not exist', () => {
  const root = makeTmpDir();
  const result = validateGuardrailsConfig(root, 'plan');
  assert.deepStrictEqual(result, { errors: [], warnings: [], guardrailCount: 0 });
});

test('validateGuardrailsConfig reads the execute section independently of plan', () => {
  const root = makeProjectRoot({
    plan: { guardrails: [VALID_GUARDRAIL] },
    execute: { guardrails: [INVALID_GUARDRAIL] },
  });
  const planResult = validateGuardrailsConfig(root, 'plan');
  const executeResult = validateGuardrailsConfig(root, 'execute');
  assert.strictEqual(planResult.errors.length, 0);
  assert.ok(executeResult.errors.length > 0);
});

// ---------------------------------------------------------------------------
// CLI — --project-root mode (existing behavior, must be preserved)
// ---------------------------------------------------------------------------

test('CLI --project-root: exits 0 with "No plan guardrails configured." when nothing is set up', () => {
  const root = makeTmpDir();
  const res = run(['--project-root', root]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /No plan guardrails configured\./);
});

test('CLI --project-root: exits 0 and reports pass for a valid guardrail', () => {
  const root = makeProjectRoot({ plan: { guardrails: [VALID_GUARDRAIL] } });
  const res = run(['--project-root', root]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /Guardrails: 1\/1 passed/);
});

test('CLI --project-root: exits 1 for an invalid guardrail', () => {
  const root = makeProjectRoot({ plan: { guardrails: [INVALID_GUARDRAIL] } });
  const res = run(['--project-root', root]);
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /id is missing/);
});

// ---------------------------------------------------------------------------
// CLI — --config-file mode (new)
// ---------------------------------------------------------------------------

test('CLI --config-file: exits 1 with "Config file not found: <path>" when the target is missing', () => {
  const missing = path.join(makeTmpDir(), 'nope.json');
  const res = run(['--config-file', missing, '--section', 'plan']);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, new RegExp(`Config file not found: ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('CLI --config-file: exits 0 and reports pass for a valid guardrail', () => {
  const file = makeConfigFile({ plan: { guardrails: [VALID_GUARDRAIL] } });
  const res = run(['--config-file', file, '--section', 'plan']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /Guardrails: 1\/1 passed/);
});

test('CLI --config-file: exits 1 for an invalid guardrail', () => {
  const file = makeConfigFile({ plan: { guardrails: [INVALID_GUARDRAIL] } });
  const res = run(['--config-file', file, '--section', 'plan']);
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /id is missing/);
});

test('CLI --config-file: honors --section, validating execute independently of plan', () => {
  const file = makeConfigFile({
    plan: { guardrails: [INVALID_GUARDRAIL] },
    execute: { guardrails: [VALID_GUARDRAIL] },
  });
  const res = run(['--config-file', file, '--section', 'execute']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /Guardrails: 1\/1 passed/);
});

test('CLI --config-file: exits 0 with "No execute guardrails configured." when the section is absent', () => {
  const file = makeConfigFile({ plan: { guardrails: [VALID_GUARDRAIL] } });
  const res = run(['--config-file', file, '--section', 'execute']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /No execute guardrails configured\./);
});

test('CLI --config-file: --json emits structured output', () => {
  const file = makeConfigFile({ plan: { guardrails: [VALID_GUARDRAIL] } });
  const res = run(['--config-file', file, '--section', 'plan', '--json']);
  assert.strictEqual(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.strictEqual(parsed.overall, 'pass');
  assert.strictEqual(parsed.summary.total, 1);
});

test('CLI --config-file: exits 1 with "Invalid JSON in <path>: <message>" for unparseable JSON', () => {
  const dir = makeTmpDir();
  const file = path.join(dir, 'config.json.harden-tmp');
  fs.writeFileSync(file, '{ not valid json', 'utf8');
  const res = run(['--config-file', file, '--section', 'plan']);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, new RegExp(`Invalid JSON in ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
});

// ---------------------------------------------------------------------------
// CLI — --config-file and --project-root are mutually exclusive
// ---------------------------------------------------------------------------

test('CLI: --config-file and --project-root together exit 1 with a mutual-exclusion message', () => {
  const file = makeConfigFile({ plan: { guardrails: [VALID_GUARDRAIL] } });
  const root = makeProjectRoot({ plan: { guardrails: [VALID_GUARDRAIL] } });
  const res = run(['--config-file', file, '--project-root', root, '--section', 'plan']);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /mutually exclusive/);
});
