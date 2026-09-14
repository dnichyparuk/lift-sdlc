'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { validateAll } = require('./discovery');

/** Build a throwaway plugin tree: { 'skills/x/SKILL.md': '…', 'skills/x/resources/FOO.md': '…' }. */
function makeTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-pd5-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

function pd5(projectRoot) {
  const report = validateAll(projectRoot);
  return report.checks.find(c => c.id === 'PD5');
}

const MINIMAL_MANIFEST = JSON.stringify({ name: 'demo', version: '1.0.0', description: 'demo' });

// ---------------------------------------------------------------------------
// PD5 resources/ prefix resolution
// ---------------------------------------------------------------------------

test('PD5 resolves `resources/FOO.md` against skills/<name>/resources/FOO.md', () => {
  const root = makeTree({
    'plugin.json': MINIMAL_MANIFEST,
    'skills/demo/SKILL.md': [
      '---',
      'name: demo',
      'description: demo skill',
      '---',
      '',
      'See `resources/FOO.md` for details.',
    ].join('\n'),
    'skills/demo/resources/FOO.md': '# Foo\n',
  });

  const finding = pd5(root);
  assert.strictEqual(finding.status, 'pass');
  assert.strictEqual(finding.id, 'PD5');
  assert.strictEqual(finding.check, 'skill-supporting-files-exist');
});

test('PD5 still resolves a bare `FOO.md` ref against skills/<name>/FOO.md', () => {
  const root = makeTree({
    'plugin.json': MINIMAL_MANIFEST,
    'skills/demo/SKILL.md': [
      '---',
      'name: demo',
      'description: demo skill',
      '---',
      '',
      'See `FOO.md` for details.',
    ].join('\n'),
    'skills/demo/FOO.md': '# Foo\n',
  });

  const finding = pd5(root);
  assert.strictEqual(finding.status, 'pass');
});

test('PD5 fails a ref that resolves to neither the skill dir nor resources/ (regression guard)', () => {
  const root = makeTree({
    'plugin.json': MINIMAL_MANIFEST,
    'skills/demo/SKILL.md': [
      '---',
      'name: demo',
      'description: demo skill',
      '---',
      '',
      'See `MISSING.md` for details.',
    ].join('\n'),
    // Neither skills/demo/MISSING.md nor skills/demo/resources/MISSING.md exists.
  });

  const finding = pd5(root);
  assert.strictEqual(finding.status, 'fail');
  assert.strictEqual(finding.id, 'PD5');
  assert.strictEqual(finding.check, 'skill-supporting-files-exist');
  assert.ok(
    finding.details.some(d => d.includes('MISSING.md')),
    `expected details to mention MISSING.md, got: ${JSON.stringify(finding.details)}`
  );
});

test('PD5 passes with no sibling refs at all', () => {
  const root = makeTree({
    'plugin.json': MINIMAL_MANIFEST,
    'skills/demo/SKILL.md': [
      '---',
      'name: demo',
      'description: demo skill',
      '---',
      '',
      'Nothing to see here.',
    ].join('\n'),
  });

  const finding = pd5(root);
  assert.strictEqual(finding.status, 'pass');
});
