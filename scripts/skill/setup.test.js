'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'setup.js');
const { SETUP_SECTIONS } = require('../lib/setup-sections.js');

test('SETUP_SECTIONS: includes properly structured learn section descriptor', () => {
  const learnEntry = SETUP_SECTIONS.find((s) => s.id === 'learn');
  assert.ok(learnEntry, 'SETUP_SECTIONS must include an entry with id="learn"');

  assert.strictEqual(learnEntry.label, 'learn');
  assert.strictEqual(learnEntry.configFile, '.sdlc/config.json');
  assert.strictEqual(learnEntry.configPath, 'learn');
  assert.deepStrictEqual(learnEntry.consumedBy, ['learn-sdlc', 'ship-sdlc']);
  assert.deepStrictEqual(learnEntry.filesModified, ['.sdlc/config.json']);
  assert.strictEqual(learnEntry.optional, true);
  assert.strictEqual(learnEntry.delegatedTo, null);
  assert.strictEqual(learnEntry.confirmDetected, false);
  assert.strictEqual(typeof learnEntry.summarize, 'function');

  const fields = learnEntry.fields;
  assert.ok(Array.isArray(fields));

  const thresholdField = fields.find((f) => f.name === 'recurrenceThreshold');
  assert.ok(thresholdField, 'learn section must configure recurrenceThreshold');
  assert.strictEqual(thresholdField.default, 3);
  assert.strictEqual(thresholdField.type, 'number');
  assert.strictEqual(thresholdField.min, 1);

  const staleField = fields.find((f) => f.name === 'staleAfterCycles');
  assert.ok(staleField, 'learn section must configure staleAfterCycles');
  assert.strictEqual(staleField.default, null);
  assert.strictEqual(staleField.type, 'number');
});

test('SETUP_SECTIONS: summarize for learn section handles varied configurations', () => {
  const learnEntry = SETUP_SECTIONS.find((s) => s.id === 'learn');

  // Unconfigured
  assert.strictEqual(learnEntry.summarize(null), '');
  assert.strictEqual(learnEntry.summarize(undefined), '');

  // Defaults
  assert.strictEqual(
    learnEntry.summarize({}),
    'threshold: 3, staleness: off'
  );

  // Custom threshold only
  assert.strictEqual(
    learnEntry.summarize({ recurrenceThreshold: 5 }),
    'threshold: 5, staleness: off'
  );

  // Custom threshold and stale window
  assert.strictEqual(
    learnEntry.summarize({ recurrenceThreshold: 2, staleAfterCycles: 14 }),
    'threshold: 2, staleness: 14d'
  );
});

test('setup.js CLI: reports learn section as not-set when config has no learn section', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-skill-test-'));
  spawnSync('git', ['init', '-q'], { cwd: root });

  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.strictEqual(res.status, 0, `setup.js failed: ${res.stderr}`);
  const manifestPath = res.stdout.trim();
  assert.ok(fs.existsSync(manifestPath), `Manifest file ${manifestPath} must exist`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.unlinkSync(manifestPath);

  const learnSection = manifest.sections.find((s) => s.id === 'learn');
  assert.ok(learnSection, 'Manifest sections must include learn section');
  assert.strictEqual(learnSection.state, 'not-set');
  assert.strictEqual(learnSection.summary, '');
});

test('setup.js CLI: reports learn section as set when config contains learn section', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-skill-test-'));
  spawnSync('git', ['init', '-q'], { cwd: root });

  const sdlcDir = path.join(root, '.sdlc');
  fs.mkdirSync(sdlcDir, { recursive: true });
  fs.writeFileSync(
    path.join(sdlcDir, 'config.json'),
    JSON.stringify({
      version: { current: '1.0.0' },
      learn: {
        recurrenceThreshold: 4,
        staleAfterCycles: 30,
      },
    }, null, 2) + '\n'
  );

  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.strictEqual(res.status, 0, `setup.js failed: ${res.stderr}`);
  const manifestPath = res.stdout.trim();
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.unlinkSync(manifestPath);

  const learnSection = manifest.sections.find((s) => s.id === 'learn');
  assert.ok(learnSection);
  assert.strictEqual(learnSection.state, 'set');
  assert.strictEqual(learnSection.summary, 'threshold: 4, staleness: 30d');
});
