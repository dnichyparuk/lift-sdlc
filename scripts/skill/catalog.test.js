'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { generateCatalog, scanProject } = require('./catalog.js');
const { buildDashboardHtml } = require('./catalog-build-html.js');

describe('catalog end-to-end integration', () => {
  test('scans project directory and produces valid delivery graph', () => {
    // Create temporary project
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-catalog-test-'));
    try {
      const plansDir = path.join(tmpDir, 'docs', 'plans');
      const todoDir = path.join(tmpDir, 'docs', 'TODO');
      fs.mkdirSync(plansDir, { recursive: true });
      fs.mkdirSync(todoDir, { recursive: true });

      const planContent = `# Feature Alpha Implementation Plan

**Goal:** Test end to end catalog generation
**Architecture:** Layered architecture
**Verification:** npm test

### Wave 1: Core Foundation

### Task 1: Initialize Module
- **Complexity:** Standard
- **Risk:** Low
- **Depends on:** none
**Acceptance criteria:**
- [x] Module initialized

### Task 2: Connect Subsystems
- **Complexity:** Complex
- **Risk:** Medium
- **Depends on:** 1
**Acceptance criteria:**
- [ ] Subsystems connected
`;
      fs.writeFileSync(path.join(plansDir, 'feature-alpha.md'), planContent, 'utf8');

      const todoContent = `# 001 - Test Blocker
| Status | open |
| Priority | P0 |
| Blocks | Task 2 |
| Related | feature-alpha |
`;
      fs.writeFileSync(path.join(todoDir, '001-test-blocker.md'), todoContent, 'utf8');

      const jsonOut = path.join(tmpDir, 'output.json');
      const htmlOut = path.join(tmpDir, 'dashboard.html');

      const { graphData, stats } = generateCatalog({
        projectDir: tmpDir,
        jsonPath: jsonOut,
        htmlPath: htmlOut
      });

      assert.equal(stats.projectsCount, 1);
      assert.equal(stats.plansCount, 1);
      assert.equal(stats.tasksCount.total, 2);
      assert.equal(stats.tasksCount.done, 1);
      assert.equal(stats.tasksCount.blocked, 1); // blocked by P0 todo

      // Verify JSON file written
      assert.ok(fs.existsSync(jsonOut));
      const parsedJson = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
      assert.equal(parsedJson.version, '1.0.0');
      assert.equal(parsedJson.projects.length, 1);
      assert.equal(parsedJson.projects[0].plans.length, 1);

      // Verify HTML file written
      assert.ok(fs.existsSync(htmlOut));
      const htmlContent = fs.readFileSync(htmlOut, 'utf8');
      assert.ok(htmlContent.includes('<script id="delivery-data" type="application/json">'));
      assert.ok(htmlContent.includes('DeliveryGraphModel'));
      assert.ok(htmlContent.includes('Feature Alpha Implementation Plan'));
      assert.ok(htmlContent.includes('marker id="arrow"'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('buildDashboardHtml throws on missing graphData or template', () => {
    assert.throws(() => {
      buildDashboardHtml({});
    }, /requires graphData/);

    assert.throws(() => {
      buildDashboardHtml({ graphData: { projects: [] }, templatePath: '/non/existent/path.html' });
    }, /not found/);
  });

  test('indexes real workspace projects when available', () => {
    const workspace = '/home/dzmitry/projects';
    if (!fs.existsSync(workspace)) return;

    const tmpJson = path.join(os.tmpdir(), 'real-workspace-catalog.json');
    const tmpHtml = path.join(os.tmpdir(), 'real-workspace-dashboard.html');

    try {
      const { graphData, stats } = generateCatalog({
        workspaceDir: workspace,
        jsonPath: tmpJson,
        htmlPath: tmpHtml
      });

      assert.ok(stats.projectsCount >= 2);
      assert.ok(stats.plansCount >= 2);
      assert.ok(stats.tasksCount.total > 0);

      assert.ok(fs.existsSync(tmpJson));
      assert.ok(fs.existsSync(tmpHtml));

      const parsed = JSON.parse(fs.readFileSync(tmpJson, 'utf8'));
      const projectIds = parsed.projects.map(p => p.id);
      assert.ok(projectIds.includes('trade-robot-alpha') || projectIds.includes('lift-fixed-price'));
    } finally {
      if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
      if (fs.existsSync(tmpHtml)) fs.unlinkSync(tmpHtml);
    }
  });
});
