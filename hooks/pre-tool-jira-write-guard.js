#!/usr/bin/env node
/**
 * pre-tool-jira-write-guard.js
 * PreToolUse hook — fail-closed guard for Jira write MCP calls.
 *
 * Intercepts createJiraIssue, editJiraIssue, and addCommentToJiraIssue calls
 * and verifies that an explicit user-approval token file exists under:
 *   <mainWorktree>/.sdlc/execution/jira-approval-*.token
 *
 * Non-Jira tools are allowed immediately. Malformed stdin or missing approval
 * tokens fail closed with `{ decision: 'deny', reason }`.
 *
 * Exit codes:
 *   0 = always (policy decision emitted as JSON on stdout)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readHookContext } = require('./lib/hook-context');
const { resolveMainWorktreeSafe } = require('../scripts/lib/worktree');

const JIRA_WRITE_RE = /(createJiraIssue|editJiraIssue|addCommentToJiraIssue)/;
const APPROVAL_TOKEN_RE = /^jira-approval-.+\.token$/;

function deny(reason) {
  process.stdout.write(JSON.stringify({ decision: 'deny', reason }) + '\n');
  process.exit(0);
}

function allow() {
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  process.exit(0);
}

// 1. Read and parse stdin fail-closed
const { ok, input, workspaceCwd } = readHookContext({ failClosed: true });
if (!ok) {
  deny('pre-tool-jira-write-guard.js: could not parse tool-call input as JSON (fail-closed). Inspect hooks.json or verify the host hook payload before retrying.');
}

// 2. Allow non-Jira-write tools immediately
const toolCall = input.toolCall || {};
const toolName = typeof toolCall.name === 'string' ? toolCall.name : '';
if (!JIRA_WRITE_RE.test(toolName)) {
  allow();
}

// 3. Check <mainWorktree>/.sdlc/execution/jira-approval-*.token
try {
  const execDir = process.env.SDLC_STATE_DIR_OVERRIDE
    ? process.env.SDLC_STATE_DIR_OVERRIDE
    : path.join(resolveMainWorktreeSafe(workspaceCwd), '.sdlc', 'execution');

  if (!fs.existsSync(execDir)) {
    deny(`Blocked: Jira write tool "${toolName}" requires an explicit approval token at ${execDir}/jira-approval-*.token. Complete jira-sdlc Step 2.5 (Critique), Step 2.6 (Approval), and Step 2.7 (Link Verification) before dispatching.`);
  }

  const entries = fs.readdirSync(execDir);
  const hasToken = entries.some((name) => {
    if (!APPROVAL_TOKEN_RE.test(name)) return false;
    try {
      return fs.statSync(path.join(execDir, name)).isFile();
    } catch (_) {
      return false;
    }
  });

  if (!hasToken) {
    deny(`Blocked: Jira write tool "${toolName}" requires an explicit approval token matching jira-approval-*.token in ${execDir}. Complete jira-sdlc Step 2.5 (Critique), Step 2.6 (Approval), and Step 2.7 (Link Verification) before dispatching.`);
  }

  allow();
} catch (err) {
  deny(`Blocked: pre-tool-jira-write-guard.js failed closed while checking Jira approval token for "${toolName}": ${err && err.message}`);
}
