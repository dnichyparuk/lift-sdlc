'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  parsePendingFile,
  filterRejected,
  groupBySignature,
  selectEligible,
  REQUIRED_FRONTMATTER_FIELDS,
  SIGNATURE_PATTERN,
} = require('./learnings');

function makeContent(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('---');
  lines.push('');
  lines.push('Body text.');
  return lines.join('\n');
}

const VALID_FIELDS = {
  signature: 'missing-timeout-guard',
  rationale: 'Repeated failures traced to missing timeout handling.',
  evidence: 'See incident-42 and incident-57 postmortems.',
};

// ---------------------------------------------------------------------------
// parsePendingFile
// ---------------------------------------------------------------------------

test('parsePendingFile: valid file without impact', () => {
  const content = makeContent(VALID_FIELDS);
  const result = parsePendingFile(content, 'pending/a.md');
  assert.deepStrictEqual(result, {
    valid: true,
    signature: VALID_FIELDS.signature,
    rationale: VALID_FIELDS.rationale,
    evidence: VALID_FIELDS.evidence,
    impact: null,
    filePath: 'pending/a.md',
  });
});

test('parsePendingFile: valid file with impact', () => {
  const content = makeContent({ ...VALID_FIELDS, impact: 'Saves ~2h per incident' });
  const result = parsePendingFile(content, 'pending/b.md');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.impact, 'Saves ~2h per incident');
});

test('parsePendingFile: missing frontmatter block is invalid, never throws', () => {
  const result = parsePendingFile('no frontmatter here', 'pending/c.md');
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.filePath, 'pending/c.md');
  assert.match(result.reason, /frontmatter/i);
});

test('parsePendingFile: missing signature is reported invalid with a reason', () => {
  const content = makeContent({ rationale: VALID_FIELDS.rationale, evidence: VALID_FIELDS.evidence });
  const result = parsePendingFile(content, 'pending/d.md');
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /signature/);
});

test('parsePendingFile: missing rationale and evidence lists both in the reason', () => {
  const content = makeContent({ signature: 'foo' });
  const result = parsePendingFile(content, 'pending/e.md');
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /rationale/);
  assert.match(result.reason, /evidence/);
});

test('parsePendingFile: non-kebab-case signature is invalid, not sanitized', () => {
  const content = makeContent({ ...VALID_FIELDS, signature: 'Missing_Timeout' });
  const result = parsePendingFile(content, 'pending/f.md');
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /kebab-case/);
  assert.ok(!('signature' in result));
});

test('parsePendingFile: signature with leading digit is invalid', () => {
  const content = makeContent({ ...VALID_FIELDS, signature: '1-bad-start' });
  const result = parsePendingFile(content, 'pending/g.md');
  assert.strictEqual(result.valid, false);
});

test('parsePendingFile: signature with trailing hyphen is invalid', () => {
  const content = makeContent({ ...VALID_FIELDS, signature: 'bad-end-' });
  const result = parsePendingFile(content, 'pending/h.md');
  assert.strictEqual(result.valid, false);
});

test('parsePendingFile: impact containing a backtick is invalid, not stripped', () => {
  const content = makeContent({ ...VALID_FIELDS, impact: 'runs `dangerous` code' });
  const result = parsePendingFile(content, 'pending/i.md');
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /backtick/);
});

test('parsePendingFile: impact over 80 chars is invalid, not truncated', () => {
  const longImpact = 'x'.repeat(81);
  const content = makeContent({ ...VALID_FIELDS, impact: longImpact });
  const result = parsePendingFile(content, 'pending/j.md');
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /impact/i);
});

test('parsePendingFile: impact at exactly 80 chars is valid', () => {
  const impact = 'x'.repeat(80);
  const content = makeContent({ ...VALID_FIELDS, impact });
  const result = parsePendingFile(content, 'pending/k.md');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.impact, impact);
});

test('parsePendingFile: impact given as a YAML list (non-string) is invalid', () => {
  const content = [
    '---',
    `signature: ${VALID_FIELDS.signature}`,
    `rationale: ${VALID_FIELDS.rationale}`,
    `evidence: ${VALID_FIELDS.evidence}`,
    'impact:',
    '  - one',
    '  - two',
    '---',
    '',
  ].join('\n');
  const result = parsePendingFile(content, 'pending/l.md');
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /string/);
});

test('parsePendingFile: rationale over 2000 chars is invalid', () => {
  const content = makeContent({ ...VALID_FIELDS, rationale: 'x'.repeat(2001) });
  const result = parsePendingFile(content, 'pending/m.md');
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /rationale/);
});

test('parsePendingFile: rationale at exactly 2000 chars is valid', () => {
  const content = makeContent({ ...VALID_FIELDS, rationale: 'x'.repeat(2000) });
  const result = parsePendingFile(content, 'pending/n.md');
  assert.strictEqual(result.valid, true);
});

test('parsePendingFile: evidence over 2000 chars is invalid', () => {
  const content = makeContent({ ...VALID_FIELDS, evidence: 'x'.repeat(2001) });
  const result = parsePendingFile(content, 'pending/o.md');
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /evidence/);
});

test('parsePendingFile: never throws on empty or degenerate content', () => {
  assert.doesNotThrow(() => parsePendingFile('', 'pending/p.md'));
  assert.doesNotThrow(() => parsePendingFile('---\n---\n', 'pending/q.md'));
  assert.strictEqual(parsePendingFile('', 'pending/p.md').valid, false);
});

// ---------------------------------------------------------------------------
// filterRejected
// ---------------------------------------------------------------------------

test('filterRejected: removes entries with exact signature match', () => {
  const parsed = [
    { signature: 'sig-a', filePath: 'a.md' },
    { signature: 'sig-b', filePath: 'b.md' },
    { signature: 'sig-c', filePath: 'c.md' },
  ];
  const result = filterRejected(parsed, ['sig-b']);
  assert.deepStrictEqual(result.map((r) => r.signature), ['sig-a', 'sig-c']);
});

test('filterRejected: does not remove non-exact substring matches', () => {
  const parsed = [{ signature: 'sig-ab', filePath: 'a.md' }];
  const result = filterRejected(parsed, ['sig-a']);
  assert.strictEqual(result.length, 1);
});

test('filterRejected: empty rejected list returns all entries unchanged', () => {
  const parsed = [{ signature: 'sig-a', filePath: 'a.md' }];
  const result = filterRejected(parsed, []);
  assert.deepStrictEqual(result, parsed);
});

// ---------------------------------------------------------------------------
// groupBySignature
// ---------------------------------------------------------------------------

test('groupBySignature: groups entries into a Map keyed by signature, preserving order', () => {
  const parsed = [
    { signature: 'sig-a', filePath: 'a1.md' },
    { signature: 'sig-b', filePath: 'b1.md' },
    { signature: 'sig-a', filePath: 'a2.md' },
  ];
  const groups = groupBySignature(parsed);
  assert.ok(groups instanceof Map);
  assert.strictEqual(groups.size, 2);
  assert.deepStrictEqual(groups.get('sig-a').map((i) => i.filePath), ['a1.md', 'a2.md']);
  assert.deepStrictEqual(groups.get('sig-b').map((i) => i.filePath), ['b1.md']);
});

test('groupBySignature: empty input returns empty Map', () => {
  const groups = groupBySignature([]);
  assert.strictEqual(groups.size, 0);
});

// ---------------------------------------------------------------------------
// selectEligible
// ---------------------------------------------------------------------------

function makeGroup(signature, count, impacts = []) {
  const items = [];
  for (let idx = 0; idx < count; idx++) {
    items.push({
      signature,
      filePath: `${signature}-${idx}.md`,
      impact: impacts[idx] !== undefined ? impacts[idx] : null,
    });
  }
  return items;
}

test('selectEligible: default threshold of 3 splits eligible from waiting', () => {
  const groups = new Map([
    ['sig-a', makeGroup('sig-a', 3)],
    ['sig-b', makeGroup('sig-b', 2)],
  ]);
  const { eligible, waiting } = selectEligible(groups);
  assert.strictEqual(eligible.length, 1);
  assert.strictEqual(eligible[0].signature, 'sig-a');
  assert.deepStrictEqual(eligible[0].files, ['sig-a-0.md', 'sig-a-1.md', 'sig-a-2.md']);
  assert.strictEqual(waiting.length, 1);
  assert.deepStrictEqual(waiting[0], { signature: 'sig-b', count: 2 });
});

test('selectEligible: custom threshold lowers the eligibility bar', () => {
  const groups = new Map([['sig-a', makeGroup('sig-a', 2)]]);
  const { eligible, waiting } = selectEligible(groups, 2);
  assert.strictEqual(eligible.length, 1);
  assert.strictEqual(waiting.length, 0);
});

test('selectEligible: group exactly at threshold is eligible', () => {
  const groups = new Map([['sig-a', makeGroup('sig-a', 3)]]);
  const { eligible, waiting } = selectEligible(groups, 3);
  assert.strictEqual(eligible.length, 1);
  assert.strictEqual(waiting.length, 0);
});

test('selectEligible: impact reduction picks first non-null impact in array order', () => {
  const groups = new Map([
    ['sig-a', makeGroup('sig-a', 3, [null, 'saves time', 'other impact'])],
  ]);
  const { eligible } = selectEligible(groups);
  assert.strictEqual(eligible[0].impact, 'saves time');
});

test('selectEligible: impact reduction is null when no file in the group sets one', () => {
  const groups = new Map([['sig-a', makeGroup('sig-a', 3)]]);
  const { eligible } = selectEligible(groups);
  assert.strictEqual(eligible[0].impact, null);
});

test('selectEligible: empty groups map returns empty eligible and waiting', () => {
  const { eligible, waiting } = selectEligible(new Map());
  assert.deepStrictEqual(eligible, []);
  assert.deepStrictEqual(waiting, []);
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

test('REQUIRED_FRONTMATTER_FIELDS contains signature, rationale, evidence', () => {
  assert.deepStrictEqual(REQUIRED_FRONTMATTER_FIELDS, ['signature', 'rationale', 'evidence']);
});

test('SIGNATURE_PATTERN matches kebab-case and rejects invalid forms', () => {
  assert.ok(SIGNATURE_PATTERN.test('missing-timeout-guard'));
  assert.ok(SIGNATURE_PATTERN.test('a'));
  assert.ok(!SIGNATURE_PATTERN.test('Missing-Timeout'));
  assert.ok(!SIGNATURE_PATTERN.test('1-bad-start'));
  assert.ok(!SIGNATURE_PATTERN.test('bad-end-'));
  assert.ok(!SIGNATURE_PATTERN.test('bad_underscore'));
});
