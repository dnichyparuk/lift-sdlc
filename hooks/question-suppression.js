#!/usr/bin/env node
/**
 * question-suppression.js
 * PreToolUse hook — intercepts `ask_question` during unattended pipeline runs (--auto).
 * Prevents mid-turn pauses on non-blocking questions (ADR-001 mid-turn pause hole).
 *
 * Gating logic:
 *   - Only fires if pipeline is advancing AND auto mode is active.
 *   - Allows questions that contain approval-gate markers (e.g. "proceed", "destructive", "approve").
 *   - Otherwise: denies the tool call with corrective guidance (take default or suspend).
 *
 * Exit codes:
 *   0 = always (fail-silent)
 */

'use strict';

const fs = require('node:fs');

const APPROVAL_GATE_MARKERS = [
  'approve',
  'proceed',
  'consent',
  'destructive',
  'confirm deletion',
  'permanent',
];

function hasApprovalMarker(text) {
  if (typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return APPROVAL_GATE_MARKERS.some(m => lower.includes(m));
}

try {
  // Read stdin
  let input = {};
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (raw && raw.trim()) input = JSON.parse(raw);
  } catch (_) {
    // Fail closed if input is unreadable or malformed
    process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'question-suppression hook could not parse tool-call input (fail-closed)' }) + '\n');
    process.exit(0);
  }

  const { pipelineAdvancing } = require('../scripts/lib/state');
  const adv = pipelineAdvancing();

  if (adv && adv.advancing && adv.auto) {
    const toolCall = input.toolCall || {};
    if (toolCall.name && toolCall.name !== 'ask_question') {
      process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
      process.exit(0);
    }

    const args = toolCall.args || {};
    const questions = Array.isArray(args.questions) ? args.questions : [];
    if (questions.length === 0) {
      process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
      process.exit(0);
    }

    let isApprovalGate = false;
    for (const q of questions) {
      if (hasApprovalMarker(q.question)) {
        isApprovalGate = true;
        break;
      }
      if (Array.isArray(q.options)) {
        for (const opt of q.options) {
          if (hasApprovalMarker(opt)) {
            isApprovalGate = true;
            break;
          }
        }
      }
      if (isApprovalGate) break;
    }

    if (!isApprovalGate) {
      const stepName = adv.step || 'current step';
      process.stdout.write(JSON.stringify({
        decision: 'deny',
        reason: `Auto mode is active (pipeline step '${stepName}' in_progress). Do NOT ask the user. For Q3 implementation choices: take the documented default and record via record-assumption.js. For Q1/Q2 blockers (missing credentials, structural ambiguity): transition the step to needs_input via the state CLI and return a structured suspension.`,
      }) + '\n');
      process.exit(0);
    }
  }
} catch (_) {
  // Fail-silent
}

process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
process.exit(0);
