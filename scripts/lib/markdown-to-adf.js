#!/usr/bin/env node
'use strict';

/**
 * markdown-to-adf.js — Convert markdown to Atlassian Document Format (ADF) v1.
 *
 * Reads markdown from stdin, writes ADF JSON to stdout.
 * No npm dependencies — Node.js built-ins only.
 *
 * Supported elements:
 *   Headings (h1-h3), bold, italic, inline code, fenced code blocks,
 *   unordered/ordered lists, links, tables, blockquotes, horizontal rules.
 *
 * Usage (CLI):   echo "# Hello" | node markdown-to-adf.js
 * Usage (API):   const { convert } = require('./markdown-to-adf.js');
 *                const adf = convert('# Hello');
 */

// ---------------------------------------------------------------------------
// Inline tokenizer — parses bold, italic, code, links within text
// ---------------------------------------------------------------------------

function tokenizeInline(text) {
  const nodes = [];
  // Regex matches: links, bold, italic, inline code, or plain text
  // Order matters: bold before italic to handle ** vs *
  const re = /(\[([^\]]+)\]\(([^)]+)\))|(`([^`]+)`)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|([^[`*]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) {
      // Link: [text](url)
      const linkText = m[2];
      const href = m[3];
      nodes.push({
        type: 'text',
        text: linkText,
        marks: [{ type: 'link', attrs: { href } }],
      });
    } else if (m[4]) {
      // Inline code: `code`
      nodes.push({
        type: 'text',
        text: m[5],
        marks: [{ type: 'code' }],
      });
    } else if (m[6]) {
      // Bold: **text**
      nodes.push({
        type: 'text',
        text: m[7],
        marks: [{ type: 'strong' }],
      });
    } else if (m[8]) {
      // Italic: *text*
      nodes.push({
        type: 'text',
        text: m[9],
        marks: [{ type: 'em' }],
      });
    } else if (m[10]) {
      // Plain text
      const t = m[10];
      if (t) {
        nodes.push({ type: 'text', text: t });
      }
    }
  }
  return nodes.length > 0 ? nodes : [{ type: 'text', text: text || '' }];
}

function inlineToContent(text) {
  return tokenizeInline(text);
}

// ---------------------------------------------------------------------------
// Table parser — parses a run of pipe-delimited lines into an ADF table
// ---------------------------------------------------------------------------

function parseTableRow(line) {
  // Split on pipe, trim, drop leading/trailing empty cells
  const cells = line.split('|').map((c) => c.trim());
  // Remove first and last if empty (from leading/trailing pipes)
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function isSeparatorRow(line) {
  // Matches rows like | --- | --- | or |:---:|---:|
  return /^\|?[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|?\s*$/.test(line);
}

function buildTable(tableLines) {
  if (tableLines.length < 2) return null;
  const headerCells = parseTableRow(tableLines[0]);
  // Skip separator row (index 1)
  const bodyStartIndex = isSeparatorRow(tableLines[1]) ? 2 : 1;
  const rows = [];

  // Header row
  rows.push({
    type: 'tableRow',
    content: headerCells.map((cell) => ({
      type: 'tableHeader',
      attrs: {},
      content: [{ type: 'paragraph', content: inlineToContent(cell) }],
    })),
  });

  // Body rows
  for (let i = bodyStartIndex; i < tableLines.length; i++) {
    const cells = parseTableRow(tableLines[i]);
    rows.push({
      type: 'tableRow',
      content: cells.map((cell) => ({
        type: 'tableCell',
        attrs: {},
        content: [{ type: 'paragraph', content: inlineToContent(cell) }],
      })),
    });
  }

  return { type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' }, content: rows };
}

// ---------------------------------------------------------------------------
// List helpers
// ---------------------------------------------------------------------------

function buildListItem(text) {
  return {
    type: 'listItem',
    content: [{ type: 'paragraph', content: inlineToContent(text) }],
  };
}

// ---------------------------------------------------------------------------
// Block parser — state machine for multi-line constructs
// ---------------------------------------------------------------------------

function convert(markdown) {
  const lines = markdown.split('\n');
  const content = [];

  let i = 0;

  function flushParagraph(text) {
    const trimmed = text.trim();
    if (trimmed) {
      content.push({ type: 'paragraph', content: inlineToContent(trimmed) });
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // --- Fenced code block ---
    const fenceMatch = line.match(/^```(\w*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || null;
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      const node = { type: 'codeBlock', content: [{ type: 'text', text: codeLines.join('\n') }] };
      if (lang) node.attrs = { language: lang };
      content.push(node);
      i++; // skip closing ```
      continue;
    }

    // --- Horizontal rule ---
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      content.push({ type: 'rule' });
      i++;
      continue;
    }

    // --- Heading ---
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      content.push({
        type: 'heading',
        attrs: { level },
        content: inlineToContent(text),
      });
      i++;
      continue;
    }

    // --- Blockquote ---
    if (line.match(/^>\s?/)) {
      const quoteLines = [];
      while (i < lines.length && lines[i].match(/^>\s?/)) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      content.push({
        type: 'blockquote',
        content: [{ type: 'paragraph', content: inlineToContent(quoteLines.join(' ').trim()) }],
      });
      continue;
    }

    // --- Unordered list ---
    if (line.match(/^[-*]\s+/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^[-*]\s+/)) {
        items.push(buildListItem(lines[i].replace(/^[-*]\s+/, '')));
        i++;
      }
      content.push({ type: 'bulletList', content: items });
      continue;
    }

    // --- Ordered list ---
    if (line.match(/^\d+\.\s+/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s+/)) {
        items.push(buildListItem(lines[i].replace(/^\d+\.\s+/, '')));
        i++;
      }
      content.push({ type: 'orderedList', content: items });
      continue;
    }

    // --- Table ---
    if (line.match(/^\|/)) {
      const tableLines = [];
      while (i < lines.length && lines[i].match(/^\|/)) {
        tableLines.push(lines[i]);
        i++;
      }
      const table = buildTable(tableLines);
      if (table) content.push(table);
      continue;
    }

    // --- Empty line (skip) ---
    if (line.trim() === '') {
      i++;
      continue;
    }

    // --- Paragraph (default) ---
    flushParagraph(line);
    i++;
  }

  // If the input was empty, produce a minimal doc with one empty paragraph
  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: '' }] });
  }

  return { version: 1, type: 'doc', content };
}

// ---------------------------------------------------------------------------
// CLI mode — read from stdin, write to stdout
// ---------------------------------------------------------------------------

if (require.main === module) {
  const { readFileSync } = require('node:fs');

  // --file <path> for file-based invocation (used by test runner)
  const fileIdx = process.argv.indexOf('--file');
  if (fileIdx !== -1 && process.argv[fileIdx + 1] !== undefined) {
    try {
      const md = readFileSync(process.argv[fileIdx + 1], 'utf8');
      const result = convert(md);
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
    } catch (err) {
      process.stderr.write(`markdown-to-adf error: ${err.message}\n`);
      process.exit(1);
    }
  } else {
    // stdin mode
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => {
      try {
        const result = convert(input);
        process.stdout.write(JSON.stringify(result));
        process.exit(0);
      } catch (err) {
        process.stderr.write(`markdown-to-adf error: ${err.message}\n`);
        process.exit(1);
      }
    });
    process.stdin.resume();
  }
} else {
  module.exports = { convert };
}
