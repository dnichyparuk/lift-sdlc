'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseArgs, detectIssueTicket, detectPrMode, matchRule, evaluateRule, validateLabelRules } = require('./pr.js');

test('parseArgs: defaults when no flags passed', () => {
  const result = parseArgs(['node', 'pr.js']);
  assert.strictEqual(result.isDraft, false);
  assert.strictEqual(result.forceUpdate, false);
  assert.strictEqual(result.baseBranchOverride, null);
  assert.strictEqual(result.isAuto, false);
  assert.deepStrictEqual(result.forcedLabels, []);
  assert.strictEqual(result.expectedBranch, null);
});

test('parseArgs: recognizes --draft, --update, --auto', () => {
  const result = parseArgs(['node', 'pr.js', '--draft', '--update', '--auto']);
  assert.strictEqual(result.isDraft, true);
  assert.strictEqual(result.forceUpdate, true);
  assert.strictEqual(result.isAuto, true);
});

test('parseArgs: --base takes the following value', () => {
  const result = parseArgs(['node', 'pr.js', '--base', 'develop']);
  assert.strictEqual(result.baseBranchOverride, 'develop');
});

test('parseArgs: --label can repeat and dedupes', () => {
  const result = parseArgs(['node', 'pr.js', '--label', 'bug', '--label', 'urgent', '--label', 'bug']);
  assert.deepStrictEqual(result.forcedLabels, ['bug', 'urgent']);
});

test('parseArgs: --expected-branch takes the following value', () => {
  const result = parseArgs(['node', 'pr.js', '--expected-branch', 'feat/x']);
  assert.strictEqual(result.expectedBranch, 'feat/x');
});

test('parseArgs: a flag missing its required value is ignored, not consumed as a positional', () => {
  const result = parseArgs(['node', 'pr.js', '--base']);
  assert.strictEqual(result.baseBranchOverride, null);
});

test('detectIssueTicket: finds a ticket key in the branch name', () => {
  const key = detectIssueTicket('feat/PROJ-123-add-thing', []);
  assert.strictEqual(key, 'PROJ-123');
});

test('detectIssueTicket: falls back to commit subjects when branch has no key', () => {
  const key = detectIssueTicket('feat/add-thing', [{ subject: 'PROJ-456: add thing' }]);
  assert.strictEqual(key, 'PROJ-456');
});

test('detectIssueTicket: returns null when no ticket key is found anywhere', () => {
  const key = detectIssueTicket('feat/add-thing', [{ subject: 'add thing' }]);
  assert.strictEqual(key, null);
});

test('detectPrMode: --update with an existing PR updates', () => {
  const result = detectPrMode(true, { exists: true, number: 3 });
  assert.deepStrictEqual(result, { mode: 'update' });
});

test('detectPrMode: --update with no existing PR errors', () => {
  const result = detectPrMode(true, { exists: false });
  assert.strictEqual(result.mode, 'create');
  assert.ok(result.error && result.error.includes('No existing PR found'));
});

test('detectPrMode: no flag, PR exists -> update', () => {
  const result = detectPrMode(false, { exists: true });
  assert.deepStrictEqual(result, { mode: 'update' });
});

test('detectPrMode: no flag, no PR -> create, no error', () => {
  const result = detectPrMode(false, { exists: false });
  assert.deepStrictEqual(result, { mode: 'create' });
});

// ---------------------------------------------------------------------------
// matchRule / evaluateRule: rule-mode label matching (issue #197)
// ---------------------------------------------------------------------------

const baseContext = {
  branch: 'feat/PROJ-123-add-thing',
  commitType: ['feat'],
  changedPaths: ['src/thing.js', 'src/thing.test.js'],
  jiraType: 'Story',
  diffLineCount: 42,
};

test('matchRule: branchPrefix matches when branch starts with a listed prefix', () => {
  const rule = { label: 'feature', when: { branchPrefix: ['feat/', 'feature/'] } };
  assert.strictEqual(matchRule(rule, baseContext), true);
});

test('matchRule: branchPrefix does not match when branch has none of the listed prefixes', () => {
  const rule = { label: 'feature', when: { branchPrefix: ['fix/', 'chore/'] } };
  assert.strictEqual(matchRule(rule, baseContext), false);
});

test('matchRule: commitType matches when any commit type in context is listed', () => {
  const rule = { label: 'feature', when: { commitType: ['feat', 'fix'] } };
  assert.strictEqual(matchRule(rule, baseContext), true);
});

test('matchRule: pathGlob matches only when every changed path matches a listed glob', () => {
  const rule = { label: 'javascript', when: { pathGlob: ['**/*.js'] } };
  assert.strictEqual(matchRule(rule, baseContext), true);

  const mixedContext = { ...baseContext, changedPaths: ['src/thing.js', 'README.md'] };
  assert.strictEqual(matchRule(rule, mixedContext), false);
});

test('matchRule: jiraType matches when the linked issue type is in the list', () => {
  const rule = { label: 'story', when: { jiraType: ['Story', 'Task'] } };
  assert.strictEqual(matchRule(rule, baseContext), true);
});

test('matchRule: diffSizeUnder matches when total lines changed is below the threshold', () => {
  const rule = { label: 'small-change', when: { diffSizeUnder: 100 } };
  assert.strictEqual(matchRule(rule, baseContext), true);

  const rule2 = { label: 'small-change', when: { diffSizeUnder: 10 } };
  assert.strictEqual(matchRule(rule2, baseContext), false);
});

test('matchRule: no-match case returns false when the signal condition is not satisfied', () => {
  const rule = { label: 'docs', when: { pathGlob: ['**/*.md'] } };
  assert.strictEqual(matchRule(rule, baseContext), false);
});

test('evaluateRule: runs only over already-validated rules and dedupes matching labels', () => {
  const validRules = [
    { label: 'feature', when: { branchPrefix: ['feat/'] } },
    { label: 'feature', when: { commitType: ['feat'] } },
    { label: 'docs', when: { pathGlob: ['**/*.md'] } },
  ];
  const result = evaluateRule(validRules, baseContext);
  assert.deepStrictEqual(result, [{ label: 'feature', source: 'rule' }]);
});

test('evaluateRule: returns an empty array when no rule matches', () => {
  const validRules = [
    { label: 'docs', when: { pathGlob: ['**/*.md'] } },
    { label: 'small-change', when: { diffSizeUnder: 1 } },
  ];
  assert.deepStrictEqual(evaluateRule(validRules, baseContext), []);
});

test('validateLabelRules: a rule using jiraType produces a dead-rule warning', () => {
  const rules = [{ label: 'story', when: { jiraType: ['Story'] } }];
  const knownSignals = ['branchPrefix', 'commitType', 'pathGlob', 'jiraType', 'diffSizeUnder'];
  const { validRules, warnings } = validateLabelRules(rules, ['story'], knownSignals);
  assert.strictEqual(validRules.length, 1);
  assert.ok(
    warnings.some(w => w === "label rule 'story' uses `jiraType`, which pr.js does not evaluate (no Jira lookup) — rule will never match"),
    `expected a jiraType dead-rule warning, got: ${JSON.stringify(warnings)}`
  );
});

test('validateLabelRules: a rule not using jiraType produces no dead-rule warning', () => {
  const rules = [{ label: 'feature', when: { branchPrefix: ['feat/'] } }];
  const knownSignals = ['branchPrefix', 'commitType', 'pathGlob', 'jiraType', 'diffSizeUnder'];
  const { validRules, warnings } = validateLabelRules(rules, ['feature'], knownSignals);
  assert.strictEqual(validRules.length, 1);
  assert.strictEqual(warnings.length, 0);
});
