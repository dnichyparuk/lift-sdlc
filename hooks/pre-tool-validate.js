#!/usr/bin/env node
/**
 * pre-tool-validate.js
 * PreToolUse hook — "Shift-Left" validation of edited files before they are written.
 *
 * Host: Antigravity (https://antigravity.google/docs/hooks/). This repo is an
 * Antigravity-native plugin — hooks.json registers this hook against Antigravity
 * tool-call matchers (`write_to_file|replace_file_content|...`), so the payload
 * read from stdin is the Antigravity shape
 * `{ toolCall: { name, args: { TargetFile, CodeContent } } }` and the output
 * written to stdout is `{ decision, reason }`. The legacy `args.Target` /
 * `args.Content` fields are still read as fallbacks (harmless, kept for
 * backward compatibility) but are not the primary path. Claude Code's
 * payload/output shapes — `{ tool_name, tool_input: { file_path, content } }`
 * input and `hookSpecificOutput` output — are intentionally NOT supported
 * here; adding a second input shape would risk a half-ported guard that fails
 * open on one host.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const os = require('node:os');

// 1. Read stdin
let input = {};
try {
  const raw = fs.readFileSync(0, 'utf8');
  if (raw.trim()) {
    input = JSON.parse(raw);
  }
} catch {
  // Stdin unreadable or non-JSON — fail closed, consistent with the other
  // PreToolUse guard hook (pre-tool-git-guard.js).
  process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'pre-tool-validate.js: could not parse tool-call input as JSON (fail-closed). If this repeats for every command, the host is sending malformed payloads — inspect hooks.json or temporarily disable this hook.' }) + '\n');
  process.exit(0);
}

const toolCall = input.toolCall || {};
const args = toolCall.args || {};
const targetFile = args.TargetFile || args.Target || null;

if (!targetFile) {
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  process.exit(0);
}

// Extract content based on tool
let proposedContent = null;
if (toolCall.name === 'write_to_file' || toolCall.name === 'write_file') {
  proposedContent = args.CodeContent || args.Content || '';
} else if (toolCall.name === 'replace_file_content' || toolCall.name === 'multi_replace_file_content') {
  // We can't perfectly reconstruct the file here without reading the original
  // and applying patches. For simplicity in this port, we will allow it 
  // and rely on SKILL.md for deep replace validation, or we just validate what we can.
  // For now, allow replacements and only block full writes if they are invalid.
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  process.exit(0);
} else {
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  process.exit(0);
}

// 2. Pattern matching
const DIMENSION_RE = /[/\\]\.(?:antigravity|sdlc)[/\\]review-dimensions[/\\][^/\\]+\.ya?ml$/;
const PR_TEMPLATE_RE = /[/\\]\.(?:antigravity|sdlc)[/\\]pr-template\.md$/;
const PLAN_RE = /[/\\]plans[/\\][^/\\]+\.md$/;

const isDimension = DIMENSION_RE.test(targetFile);
const isPrTemplate = PR_TEMPLATE_RE.test(targetFile);
const isPlan = PLAN_RE.test(targetFile);

if (!isDimension && !isPrTemplate && !isPlan) {
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  process.exit(0);
}

// 3. Locate validator scripts
const scriptsDir = path.resolve(__dirname, '..', 'scripts');
let validatorScript;
if (isDimension) {
  validatorScript = path.join(scriptsDir, 'ci', 'validate-dimensions.js');
} else if (isPrTemplate) {
  validatorScript = path.join(scriptsDir, 'ci', 'validate-pr-template.js');
} else {
  validatorScript = path.join(scriptsDir, 'ci', 'validate-plan-format.js');
}

// 4. Run validator on a temporary file
try {
  const tempFile = path.join(os.tmpdir(), `validate-${Date.now()}-${path.basename(targetFile)}`);
  fs.writeFileSync(tempFile, proposedContent, 'utf8');

  // Currently, validate-dimensions.js only supports project-root validation, not single files.
  // We handle validate-plan-format which supports --file
  let cmd;
  if (isPlan) {
    cmd = `node "${validatorScript}" --file "${tempFile}" --markdown`;
  } else {
    // For dimensions and pr-template, we fallback to allow since they require project-root scanning
    // This is a known limitation of the Shift-Left port.
    fs.unlinkSync(tempFile);
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
    process.exit(0);
  }

  execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.unlinkSync(tempFile);
  
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  process.exit(0);
} catch (err) {
  const stdout = (err.stdout || '').trim();
  const stderr = (err.stderr || '').trim();
  const findings = stdout || stderr || err.message;

  process.stdout.write(JSON.stringify({ decision: 'deny', reason: `Validation Failed:\n${findings}` }) + '\n');
  process.exit(0);
}
