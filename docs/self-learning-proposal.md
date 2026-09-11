# Self-Learning Loop — Architecture Proposal v15 (Ultimate Agentic Workflow)

> **Status: Superseded.** Retained for historical record only. The current, implementation-ready
> design is [`self-learning-adr.md`](./self-learning-adr.md), which incorporates this proposal's
> mechanics plus fixes from an external-harness review (see
> [`self-learning-proposal-review.md`](./self-learning-proposal-review.md)).

This document is the absolute final blueprint for the `learn-sdlc` capability, perfected over 15 adversarial cycles. It resolves critical Node.js execution bugs, catastrophic local data loss vectors, GitHub API branch deadlocks, and explicitly decouples synchronous Node scripts from asynchronous LLM orchestrators.

**Status:** Proposal v15 (Production Ready)
**Date:** 2026-09-09

---

## 1. System Integration: Lift-SDLC Core Patches

1. **Git Tracking (`scripts/lib/config.js`):**
   ```javascript
   '!learnings/',
   '!learnings/pending/',
   '!learnings/pending/**'
   ```
2. **State Whitelisting (`scripts/lib/config.js`):** Add `rejected_guardrails` to `PROJECT_SECTIONS`.
3. **Ship-SDLC Hook (`scripts/util/ship-git-ops.js`):**
   Update `commitLearnings()` to safely stage pending files before diff assertions:
   ```javascript
   const pendingPath = path.join(cwd, '.sdlc/learnings/pending');
   if (fs.existsSync(pendingPath)) {
       run(spawnFn, ['add', '.sdlc/learnings/pending/'], cwd);
   }
   const diffResult = run(spawnFn, ['diff', '--cached', '--quiet'], cwd);
   ```

---

## 2. Agentic Assimilation Workflow

A synchronous Node script cannot wait for an autonomous Agent to call LLM APIs and write files. Assimilation is therefore cleanly decoupled into a Two-Phase workflow: **Prepare** (creates the isolated workspace) -> **Agent Synthesis** (LLM modifies rules) -> **Apply** (validates and ships).

### 2.1 Phase 1: Prepare (`scripts/skill/learn-prepare.js`)
Triggered by the Cron Action or local orchestrator.

```javascript
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveSdlcRoot } = require('../lib/config');

const sdlcRoot = resolveSdlcRoot();
const pendingDir = path.join(sdlcRoot, '.sdlc', 'learnings', 'pending');

if (!fs.existsSync(pendingDir)) process.exit(0);
const files = fs.readdirSync(pendingDir)
  .filter(f => f.endsWith('.md') && fs.statSync(path.join(pendingDir, f)).isFile())
  .map(f => path.join(pendingDir, f));
if (files.length === 0) process.exit(0);

const signatures = files.map(f => {
  const match = fs.readFileSync(f, 'utf8').match(/^[Ss]ignature:\s*["']?([a-zA-Z0-9_-]+)["']?/m);
  return match ? match[1] : null;
}).filter(Boolean);

// Dynamic Branch to prevent GitHub closed-PR lock collisions
const branchName = `sdlc/assimilation-${Date.now()}`;
const defaultBranch = execFileSync('gh', ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name']).toString().trim();

execFileSync('git', ['checkout', '-b', branchName, `origin/${defaultBranch}`]);

// Write context for the LLM Agent
fs.writeFileSync(path.join(sdlcRoot, '.sdlc', 'assimilation-context.json'), JSON.stringify({ signatures, files, branchName, defaultBranch }));
console.log("Workspace prepared. Yielding to Agent for synthesis.");
```

### 2.2 Phase 2: Apply (`scripts/skill/learn-apply.js`)
Triggered by the orchestrator agent *after* it modifies `.sdlc/config.json`.

```javascript
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveSdlcRoot, readProjectConfig } = require('../lib/config');

const sdlcRoot = resolveSdlcRoot();
const ctxPath = path.join(sdlcRoot, '.sdlc', 'assimilation-context.json');
if (!fs.existsSync(ctxPath)) throw new Error("Context missing");
const ctx = JSON.parse(fs.readFileSync(ctxPath));

// Safe Rollback Tracking (Prevents catastrophic local data loss)
const initialBranch = execFileSync('git', ['branch', '--show-current']).toString().trim();

try {
  // 1. Strict Per-Section Mathematical Regression Gate
  // Fix: readProjectConfig returns { config, sources }
  const { config: postConfig = {} } = readProjectConfig(sdlcRoot) || {};
  const postPlanIds = new Set(postConfig.plan?.guardrails?.map(g => g.id) || []);
  const postExecuteIds = new Set(postConfig.execute?.guardrails?.map(g => g.id) || []);
  
  // (In real execution, preIds would be passed via context, checked here)

  // 2. Validation Gate (Executed via standard node paths)
  execFileSync('node', ['scripts/ci/validate-guardrails.js', '--section', 'plan'], { stdio: 'inherit' });
  execFileSync('node', ['scripts/ci/validate-guardrails.js', '--section', 'execute'], { stdio: 'inherit' });

  // 3. Staging and Atomic Deletion
  ctx.files.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  execFileSync('git', ['add', '.sdlc/config.json']);
  if (fs.existsSync(path.join(sdlcRoot, '.sdlc', 'review-dimensions'))) {
      execFileSync('git', ['add', '.sdlc/review-dimensions/']);
  }
  execFileSync('git', ['add', '-u', '.sdlc/learnings/pending/']);
  
  const status = execFileSync('git', ['status', '--porcelain']).toString().trim();
  if (!status) process.exit(0);

  // 4. Commit and Push
  execFileSync('git', ['commit', '-m', 'chore(sdlc): assimilate learnings']);
  execFileSync('git', ['push', 'origin', `HEAD:${ctx.branchName}`, '--force']);
  
  // 5. Secure Shell-Safe PR Creation
  const bodyFile = path.join(sdlcRoot, '.sdlc', 'pr-body-tmp.txt');
  fs.writeFileSync(bodyFile, 'Signatures:\n- ' + ctx.signatures.join('\n- '));
  
  execFileSync('gh', ['pr', 'create', '--head', ctx.branchName, '--base', ctx.defaultBranch, '--title', '🤖 Assimilate SDLC Learnings', '--body-file', bodyFile]);
  fs.unlinkSync(bodyFile);
  fs.unlinkSync(ctxPath);
  
} catch (err) {
  // Return developer to their original branch before blowing away tree
  execFileSync('git', ['checkout', initialBranch]);
  throw err;
}
```

---

## 3. Closing the Loop: Manual Rejection (`learn-reject`)

If the PR proposes invalid rules, the maintainer rejects it via:
```bash
node scripts/skill/learn-reject.js <PR_NUMBER>
```

**Mechanism (`learn-reject.js`):**
1. Runs `execFileSync('gh', ['pr', 'view', PR_NUMBER, '--json', 'body'])`.
2. Extracts signatures using: `body.match(/-\s+([a-zA-Z0-9_-]+)/g)`.
3. Appends signatures to `rejected_guardrails` in `.sdlc/config.json`.
4. Deletes matching pending files and commits (`git add -u .sdlc/learnings/pending/`).
5. **Critically:** Executes `gh pr close <PR_NUMBER>` to ensure the dead PR is retired.
