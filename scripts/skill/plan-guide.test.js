'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { initPlanGuide, AGENTS_SECTION_HEADER } = require('./plan-guide.js');

const REPO_ROOT = path.resolve(__dirname, '../..');
const TEMPLATE_GUIDE = path.join(REPO_ROOT, 'templates', 'guidelines', 'PLAN_GUIDELINES.md');
const SKILL_GUIDE = path.join(REPO_ROOT, 'skills', 'plan-guide-sdlc', 'PLAN_GUIDELINES.md');
const SCRIPT = path.join(__dirname, 'plan-guide.js');
const EXPECTED_TITLE = '# Plan Authoring Guidelines';

function firstLine(text) {
  return text.split('\n', 1)[0];
}

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

  test('template and skill copies of PLAN_GUIDELINES.md are byte-identical', () => {
    assert.ok(
      fs.readFileSync(TEMPLATE_GUIDE).equals(fs.readFileSync(SKILL_GUIDE)),
      'skills/plan-guide-sdlc/PLAN_GUIDELINES.md must be identical to templates/guidelines/PLAN_GUIDELINES.md'
    );
  });

  test('deploys the English title into the project', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-guide-test-'));
    try {
      initPlanGuide({ projectDir: tmpDir });
      const written = fs.readFileSync(path.join(tmpDir, 'docs', 'plans', 'PLAN_GUIDELINES.md'), 'utf8');
      assert.equal(firstLine(written), EXPECTED_TITLE);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('--force overwrites an existing guide with the English title (CLI)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-guide-test-'));
    try {
      const guidePath = path.join(tmpDir, 'docs', 'plans', 'PLAN_GUIDELINES.md');
      fs.mkdirSync(path.dirname(guidePath), { recursive: true });
      fs.writeFileSync(guidePath, '# Old localized title\n\nstale content\n', 'utf8');

      execFileSync(process.execPath, [SCRIPT, '--project', tmpDir], { stdio: 'pipe' });
      assert.equal(firstLine(fs.readFileSync(guidePath, 'utf8')), '# Old localized title', 'without --force the guide is kept');

      execFileSync(process.execPath, [SCRIPT, '--project', tmpDir, '--force'], { stdio: 'pipe' });
      const written = fs.readFileSync(guidePath, 'utf8');
      assert.equal(firstLine(written), EXPECTED_TITLE);
      assert.equal(written, fs.readFileSync(TEMPLATE_GUIDE, 'utf8'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
