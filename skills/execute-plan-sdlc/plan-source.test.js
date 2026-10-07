'use strict';

// Contract test: execute-plan-sdlc takes its plan only from an explicit path
// (positional *.md, --plan, --plan-file) or a resumed state file's planPath —
// never from conversation context. Guards the skill text against the removed
// "Smart loading" fallback coming back.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const EXECUTE = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
const PLAN = fs.readFileSync(path.join(__dirname, '..', 'plan-sdlc', 'SKILL.md'), 'utf8');

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(m, 'SKILL.md has frontmatter');
  return m[1];
}

test('execute-plan-sdlc frontmatter: plan path is required and never inferred from context', () => {
  const fm = frontmatter(EXECUTE);
  assert.match(fm, /^argument-hint: "<plan-file-path> /m);
  assert.match(fm, /--plan-file <path> \| --plan <path>/);
  assert.match(fm, /never inferred from conversation context/);
  assert.doesNotMatch(fm, /plan content is already in conversation context/);
});

test('execute-plan-sdlc body: explicit-only plan source with a stop gate, no context fallback', () => {
  assert.match(EXECUTE, /\*\*Plan-argument gate:\*\*/);
  assert.match(EXECUTE, /execute-plan-sdlc cannot run without an explicit plan file\./);
  assert.doesNotMatch(EXECUTE, /Smart loading/);
  assert.doesNotMatch(EXECUTE, /use `ask_question` to request the plan file path/);
});

test('plan-sdlc handoff names the plan path for ship and execute', () => {
  assert.match(PLAN, /\/execute-plan-sdlc <path>/);
  assert.match(PLAN, /\/ship-sdlc --plan <path>/);
  assert.doesNotMatch(PLAN, /execute the plan only \(\/execute-plan-sdlc\)/);
});
