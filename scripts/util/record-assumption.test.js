'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'record-assumption.js');

test('record-assumption: appends assumptions to ASSUMPTIONS_<runId>.md', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assume-test-'));
  try {
    const runId = '20260907T123456Z';
    const stateFile = path.join(tempDir, `ship-main-${runId}.json`);
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, assumptions: [] }), 'utf8');

    const res = spawnSync(process.execPath, [
      SCRIPT,
      '--state-file', stateFile,
      '--step', 'review',
      '--question-class', 'Q3',
      '--decision', 'Used default eslint rules',
      '--rationale', 'Config was absent',
    ], { encoding: 'utf8' });

    assert.strictEqual(res.status, 0, res.stderr);
    const json = JSON.parse(res.stdout);
    assert.strictEqual(json.recorded, true);

    const ledgerPath = path.join(tempDir, `ASSUMPTIONS_${runId}.md`);
    assert.ok(fs.existsSync(ledgerPath));
    const content = fs.readFileSync(ledgerPath, 'utf8');
    assert.ok(content.includes('Assumptions Ledger'));
    assert.ok(content.includes('review'));
    assert.ok(content.includes('Q3'));
    assert.ok(content.includes('Used default eslint rules'));

    // Check state file update
    const updatedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(updatedState.assumptions.length, 1);
    assert.strictEqual(updatedState.assumptions[0].questionClass, 'Q3');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('record-assumption: fails with code 1 on missing required args', () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
});
