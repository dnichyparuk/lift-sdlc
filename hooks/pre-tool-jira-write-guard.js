#!/usr/bin/env node
/**
 * pre-tool-jira-write-guard.js
 * PreToolUse hook — fail-closed guard for Jira write MCP calls.
 *
 * Intercepts createJiraIssue, editJiraIssue, and addCommentToJiraIssue calls
 * and verifies that a fresh (< 10 min TTL) user-approval token paired with its
 * matching critique artifact exists under the canonical artifact-store directory
 * (`$TMPDIR/jira-sdlc` via `skills/jira-sdlc/lib/artifact-store.js`):
 *   - approval-<hash>.token
 *   - critique-<hash>.json
 *
 * Non-Jira tools are allowed immediately. Malformed stdin or missing, unpaired,
 * or expired artifacts fail closed with `{ decision: 'deny', reason }`.
 *
 * Exit codes:
 *   0 = always (policy decision emitted as JSON on stdout)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readHookContext } = require('./lib/hook-context');
const { TTL_MS, storeDir } = require('../skills/jira-sdlc/lib/artifact-store');

const JIRA_WRITE_RE = /(createJiraIssue|editJiraIssue|addCommentToJiraIssue)/;
const APPROVAL_TOKEN_RE = /^approval-([A-Za-z0-9_-]+)\.token$/;

function deny(reason) {
  process.stdout.write(JSON.stringify({ decision: 'deny', reason }) + '\n');
  process.exit(0);
}

function allow() {
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  process.exit(0);
}

function resolveStoreDir() {
  if (process.env.SDLC_JIRA_STORE_DIR_OVERRIDE) {
    return process.env.SDLC_JIRA_STORE_DIR_OVERRIDE;
  }
  if (process.env.SDLC_STATE_DIR_OVERRIDE) {
    return process.env.SDLC_STATE_DIR_OVERRIDE;
  }
  return storeDir();
}

// 1. Read and parse stdin fail-closed
const { ok, input } = readHookContext({ failClosed: true });
if (!ok) {
  deny('pre-tool-jira-write-guard.js: could not parse tool-call input as JSON (fail-closed). Inspect hooks.json or verify the host hook payload before retrying.');
}

// 2. Allow non-Jira-write tools immediately
const toolCall = input.toolCall || {};
const toolName = typeof toolCall.name === 'string' ? toolCall.name : '';
if (!JIRA_WRITE_RE.test(toolName)) {
  allow();
}

// 3. Verify fresh (< TTL_MS) paired approval-<hash>.token + critique-<hash>.json
try {
  const dir = resolveStoreDir();

  if (!fs.existsSync(dir)) {
    deny(`Blocked: Jira write tool "${toolName}" requires a fresh paired approval-<hash>.token and critique-<hash>.json in ${dir}. Complete jira-sdlc Step 2.5 (Critique), Step 2.6 (Approval), and Step 2.7 (Link Verification) before dispatching.`);
  }

  const entries = fs.readdirSync(dir);
  const now = Date.now();
  let sawApprovalToken = false;
  let sawUnpaired = false;
  let sawExpired = false;
  let sawMalformedCritique = false;

  for (const name of entries) {
    const match = APPROVAL_TOKEN_RE.exec(name);
    if (!match) continue;

    const hash = match[1];
    const approvalFile = path.join(dir, name);
    let aStat;
    try {
      aStat = fs.statSync(approvalFile);
      if (!aStat.isFile()) continue;
    } catch (_) {
      continue;
    }

    sawApprovalToken = true;

    const critiqueFile = path.join(dir, `critique-${hash}.json`);
    let cStat;
    try {
      cStat = fs.statSync(critiqueFile);
      if (!cStat.isFile()) {
        sawUnpaired = true;
        continue;
      }
    } catch (_) {
      sawUnpaired = true;
      continue;
    }

    if (now - aStat.mtimeMs > TTL_MS || now - cStat.mtimeMs > TTL_MS) {
      sawExpired = true;
      continue;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(critiqueFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object') {
        sawMalformedCritique = true;
        continue;
      }
    } catch (_) {
      sawMalformedCritique = true;
      continue;
    }

    allow();
  }

  if (!sawApprovalToken) {
    deny(`Blocked: Jira write tool "${toolName}" requires a fresh paired approval-<hash>.token and critique-<hash>.json in ${dir} (no approval token found). Complete jira-sdlc Step 2.5 (Critique), Step 2.6 (Approval), and Step 2.7 (Link Verification) before dispatching.`);
  }
  if (sawExpired) {
    deny(`Blocked: Jira write tool "${toolName}" approval/critique artifact pair in ${dir} is expired (> 10 min TTL). Re-run jira-sdlc Step 2.5 (Critique), Step 2.6 (Approval), and Step 2.7 (Link Verification) to mint fresh artifacts.`);
  }
  if (sawMalformedCritique) {
    deny(`Blocked: Jira write tool "${toolName}" paired critique-<hash>.json in ${dir} is unreadable or invalid JSON. Re-run jira-sdlc Step 2.5 (Critique) and Step 2.6 (Approval) via lib/artifact-store.js.`);
  }
  if (sawUnpaired) {
    deny(`Blocked: Jira write tool "${toolName}" found approval-<hash>.token in ${dir} without a matching critique-<hash>.json for the same hash. Complete jira-sdlc Step 2.5 (Critique) and Step 2.6 (Approval) together before dispatching.`);
  }

  deny(`Blocked: Jira write tool "${toolName}" requires a fresh paired approval-<hash>.token and critique-<hash>.json in ${dir}. Complete jira-sdlc Step 2.5 (Critique), Step 2.6 (Approval), and Step 2.7 (Link Verification) before dispatching.`);
} catch (err) {
  deny(`Blocked: pre-tool-jira-write-guard.js failed closed while checking Jira approval artifacts for "${toolName}": ${err && err.message}`);
}
