#!/usr/bin/env node
'use strict';

/**
 * outline-file.js — Codebase exploration tool to extract structural outlines
 * without bloating context window.
 *
 * Pure-Node reimplementation of skills/plan-sdlc/scripts/outline_file.sh:
 *   grep -nE '^[[:space:]]*(export|import|class|def|function|struct|interface|type|enum|const|let|var)[[:space:]]+' "$FILE_PATH" | head -n 300
 *
 * No shelling out to grep/head — reads the file, splits on newlines, and
 * runs the equivalent RegExp per line, capping at 300 matched lines.
 *
 * Usage:
 *   node outline-file.js <file_path>
 *
 * Output (stdout):
 *   --- OUTLINE FOR <file_path> ---
 *   <lineNumber>:<matching line>
 *   ... (at most 300 matching lines, in original file order)
 *
 * Exit codes:
 *   0 = success (including zero matches — mirrors `grep | head` always exiting 0)
 *   1 = usage error (missing arg) or file not found
 *
 * Zero npm dependencies — Node.js built-ins only.
 */

const fs = require('node:fs');

// Equivalent to grep -nE '^[[:space:]]*(export|import|class|def|function|struct|interface|type|enum|const|let|var)[[:space:]]+'
// POSIX [[:space:]] == JS \s for the ASCII line content grep operates on.
const OUTLINE_RE = /^\s*(export|import|class|def|function|struct|interface|type|enum|const|let|var)\s+/;
const MAX_MATCHES = 300;

function parseArgs(argv) {
  return { filePath: argv[2] || null };
}

/**
 * Returns up to MAX_MATCHES "<lineNumber>:<line>" strings (1-indexed, like
 * `grep -n`) for lines in `content` matching OUTLINE_RE, in file order.
 */
function outlineLines(content) {
  const lines = content.split('\n');
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    if (OUTLINE_RE.test(lines[i])) {
      matches.push(`${i + 1}:${lines[i]}`);
      if (matches.length >= MAX_MATCHES) break;
    }
  }
  return matches;
}

/**
 * Runs the outline CLI. Writes to stdout/stderr and returns an exit code
 * (does not call process.exit — callers decide when to exit).
 */
function main(argv) {
  const { filePath } = parseArgs(argv);
  if (!filePath) {
    process.stderr.write(`Usage: outline-file.js <file_path>\n`);
    return 1;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    process.stderr.write(`Error: File not found - ${filePath}\n`);
    return 1;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  process.stdout.write(`--- OUTLINE FOR ${filePath} ---\n`);
  const matches = outlineLines(content);
  if (matches.length) {
    process.stdout.write(matches.join('\n') + '\n');
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { parseArgs, outlineLines, main, OUTLINE_RE, MAX_MATCHES };
