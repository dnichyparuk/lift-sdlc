'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'generate-run-audit.js');

test('generate-run-audit: creates markdown audit report from state file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  try {
    const runId = '20260907T180000Z';
    const stateFile = path.join(tempDir, `ship-feature-test-${runId}.json`);

    const data = {
      pipeline: 'ship-sdlc',
      branch: 'feature-test',
      startedAt: '2026-09-07T18:00:00Z',
      flags: { auto: true },
      steps: [
        { name: 'execute', status: 'completed', result: 'All 3 tasks finished' },
        { name: 'commit', status: 'completed', result: 'Committed sha 123456' },
        { name: 'review', status: 'skipped', skipReason: 'no-changes' },
      ],
      decisions: [
        { step: 'review', text: 'Clean verdict', timestamp: '2026-09-07T18:05:00Z' },
      ],
    };

    fs.writeFileSync(stateFile, JSON.stringify(data, null, 2), 'utf8');

    const res = spawnSync(process.execPath, [SCRIPT, '--state-file', stateFile], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, res.stderr);

    const json = JSON.parse(res.stdout);
    assert.strictEqual(json.generated, true);

    const auditPath = path.join(tempDir, `RUN_AUDIT_${runId}.md`);
    assert.ok(fs.existsSync(auditPath));

    const content = fs.readFileSync(auditPath, 'utf8');
    assert.ok(content.includes('Run Audit — ship-sdlc'));
    assert.ok(content.includes('All 3 tasks finished'));
    assert.ok(content.includes('Clean verdict'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
