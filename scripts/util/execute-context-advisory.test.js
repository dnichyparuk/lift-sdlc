'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

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
