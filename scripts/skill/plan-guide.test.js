'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { initPlanGuide, AGENTS_SECTION_HEADER } = require('./plan-guide.js');

describe('plan-guide skill script', () => {
  test('initializes guidelines in a clean project directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-guide-test-'));
    try {
      const result = initPlanGuide({ projectDir: tmpDir });
      assert.equal(result.success, true);
      assert.ok(result.filesCreated.includes(path.join('docs', 'plans', 'PLAN_GUIDELINES.md')));
      assert.ok(result.filesCreated.includes(path.join('docs', 'plans', 'README.md')));

      const guideContent = fs.readFileSync(path.join(tmpDir, 'docs', 'plans', 'PLAN_GUIDELINES.md'), 'utf8');
      assert.ok(guideContent.includes('### Task 1:'));
      assert.ok(guideContent.includes('Depends on:'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('updates AGENTS.md when present and avoids duplicate injections', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-guide-test-'));
    try {
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(agentsPath, '# Existing Project Guidance\n\nSome guidelines here.\n', 'utf8');

      // First run
      const res1 = initPlanGuide({ projectDir: tmpDir });
      assert.ok(res1.filesUpdated.includes('AGENTS.md'));

      const updatedContent1 = fs.readFileSync(agentsPath, 'utf8');
      assert.ok(updatedContent1.includes(AGENTS_SECTION_HEADER));
      assert.ok(updatedContent1.includes('PLAN_GUIDELINES.md'));

      // Second run (idempotent)
      const res2 = initPlanGuide({ projectDir: tmpDir });
      assert.equal(res2.filesUpdated.length, 0);

      const updatedContent2 = fs.readFileSync(agentsPath, 'utf8');
      // Ensure section header occurs exactly once
      const occurrences = updatedContent2.split(AGENTS_SECTION_HEADER).length - 1;
      assert.equal(occurrences, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
