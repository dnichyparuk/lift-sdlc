#!/usr/bin/env node
'use strict';

/**
 * plan-guide.js
 *
 * Initializes or updates plan authoring guidelines (`docs/plans/PLAN_GUIDELINES.md`)
 * and injects relative references into `AGENTS.md` and/or `CLAUDE.md`.
 */

const fs = require('node:fs');
const path = require('node:path');

const AGENTS_SECTION_HEADER = '### Plan Authoring Standard (`docs/plans/`)';

const AGENTS_INJECTION_SNIPPET = `
### Plan Authoring Standard (\`docs/plans/\`)
When authoring or modifying implementation plans under \`docs/plans/\`, agents **MUST** follow the guidelines in [\`docs/plans/PLAN_GUIDELINES.md\`](docs/plans/PLAN_GUIDELINES.md). Specifically:
- Use explicit task headers (\`### Task N: <Title>\`).
- Always declare \`- **Depends on:**\` (\`none\` if unblocked) for topological DAG ordering and Critical Path computation.
- Define actionable acceptance criteria with checkboxes (\`- [ ]\`) to track execution progress.
- Mark a criterion skipped on purpose with \`- [~]\` only when a person decides it (or asks an agent to), with an indented \`*Skipped on YYYY-MM-DD: <reason>*\` line right below it; a skipped box counts as closed.
- Specify affected files under \`- **Files:**\` (\`Create:\`, \`Modify:\`, \`Delete:\`, \`Test:\`).
`;

/**
 * Initialize plan guidelines in a target project directory
 * @param {Object} options
 * @param {string} [options.projectDir]
 * @param {boolean} [options.force]
 * @returns {{ success: boolean, filesCreated: string[], filesUpdated: string[] }}
 */
function initPlanGuide(options = {}) {
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const force = Boolean(options.force);

  const filesCreated = [];
  const filesUpdated = [];

  // 1. Ensure docs/plans directory exists
  const plansDir = path.join(projectDir, 'docs', 'plans');
  if (!fs.existsSync(plansDir)) {
    fs.mkdirSync(plansDir, { recursive: true });
  }

  // 2. Resolve template content
  const templatePath = path.resolve(__dirname, '../../templates/guidelines/PLAN_GUIDELINES.md');
  let guideContent;
  if (fs.existsSync(templatePath)) {
    guideContent = fs.readFileSync(templatePath, 'utf8');
  } else {
    // Embedded fallback if template missing
    guideContent = `# Plan Authoring Guidelines\n\nSee docs/plans/PLAN_GUIDELINES.md\n`;
  }

  // 3. Write docs/plans/PLAN_GUIDELINES.md
  const targetGuidePath = path.join(plansDir, 'PLAN_GUIDELINES.md');
  if (!fs.existsSync(targetGuidePath) || force) {
    fs.writeFileSync(targetGuidePath, guideContent, 'utf8');
    filesCreated.push(path.relative(projectDir, targetGuidePath));
  }

  // 4. Check & Update AGENTS.md
  const agentsPath = path.join(projectDir, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    const agentsContent = fs.readFileSync(agentsPath, 'utf8');
    if (!agentsContent.includes(AGENTS_SECTION_HEADER) && !agentsContent.includes('PLAN_GUIDELINES.md')) {
      let updatedAgentsContent = agentsContent.trimEnd() + '\n\n---\n' + AGENTS_INJECTION_SNIPPET.trim() + '\n';
      fs.writeFileSync(agentsPath, updatedAgentsContent, 'utf8');
      filesUpdated.push(path.relative(projectDir, agentsPath));
    }
  }

  // 5. Check & Create docs/plans/README.md if missing
  const plansReadmePath = path.join(plansDir, 'README.md');
  if (!fs.existsSync(plansReadmePath)) {
    const starterReadme = `# Active Improvement Plans — Catalog\n\nThis folder is the working home for active implementation plans.\n\nAll plans must adhere to the format specified in [\`PLAN_GUIDELINES.md\`](./PLAN_GUIDELINES.md).\n`;
    fs.writeFileSync(plansReadmePath, starterReadme, 'utf8');
    filesCreated.push(path.relative(projectDir, plansReadmePath));
  }

  return {
    success: true,
    projectDir,
    filesCreated,
    filesUpdated
  };
}

// CLI Execution
if (require.main === module) {
  const args = process.argv.slice(2);
  let projectDir = process.cwd();
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      projectDir = args[++i];
    } else if (args[i] === '--force') {
      force = true;
    }
  }

  try {
    const result = initPlanGuide({ projectDir, force });
    console.log(`=== Plan Guidelines Initialized ===`);
    console.log(`Project Directory : ${result.projectDir}`);
    console.log(`Files Created     : ${result.filesCreated.join(', ') || 'none'}`);
    console.log(`Files Updated     : ${result.filesUpdated.join(', ') || 'none'}`);
    console.log(`===================================`);
  } catch (err) {
    console.error(`Error initializing plan guide:`, err.message);
    process.exit(1);
  }
}

module.exports = {
  initPlanGuide,
  AGENTS_SECTION_HEADER,
  AGENTS_INJECTION_SNIPPET
};
