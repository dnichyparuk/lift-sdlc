'use strict';

/**
 * plan-checkboxes.js
 * Reads the Markdown task-list boxes of a plan file:
 *   `- [ ]` open, `- [x]` / `- [X]` done, `- [~]` skipped on purpose.
 *
 * A box is any list item (`-`, `*`, `+`, `1.`, `1)`, at any nesting level) that starts with one of
 * these markers followed by whitespace or the end of the line. Boxes inside fenced code blocks are
 * ignored. A skipped box is closed (like `[x]`) and MUST carry a comment on the item's indented
 * continuation line(s) — the lines right after the box line, indented deeper than the list marker,
 * with no blank line in between:
 *
 *   - [~] The GATE passes.
 *     *Skipped on 2026-10-06: the next task's GATE covers it and the branch is merged.*
 *
 * The date must be a real calendar date and the reason at least MIN_SKIP_REASON characters long
 * once Markdown markup is stripped. A comment on the box line itself does not count.
 *
 * Pure module, zero npm dependencies.
 */

/** A task-list box; group 1 is the marker character. */
const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX~])\](?:\s|$)/;
/** Any list item line (it ends the continuation lines of the item above it). */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/;
/** A code fence line: up to 3 spaces of indent, 3+ backticks or tildes, then the info string. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** The required comment of a `[~]` box, searched in its continuation lines joined by spaces. */
const SKIP_COMMENT = /(?:^|\s)\*Skipped on ([^:*]*?):(.*?)\*(?=\s|$)/;
/** Minimum length of a skip reason after markup and surrounding whitespace are stripped. */
const MIN_SKIP_REASON = 15;
/** The comment format, as shown in problem messages. */
const SKIP_COMMENT_FORMAT = `*Skipped on YYYY-MM-DD: <reason of at least ${MIN_SKIP_REASON} characters>*`;

/**
 * Splits Markdown into lines and marks each line that is a fence line or inside a fenced code
 * block (a closing fence uses the same character, is at least as long as the opener and has no
 * info string). CRLF input is split like LF.
 *
 * @param {string} markdown
 * @returns {{ text: string, fenced: boolean }[]}
 */
function markFences(markdown) {
  let fence = null;
  return String(markdown == null ? '' : markdown).split(/\r?\n/).map((text) => {
    const f = FENCE.exec(text);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === '') fence = null;
      return { text, fenced: true };
    }
    return { text, fenced: fence !== null };
  });
}

/** The indentation width of a line, tabs expanded to the next multiple of 4. */
function indentWidth(line) {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** `true` when `iso` is `YYYY-MM-DD` and names a real calendar date. */
function isCalendarDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3])); // Date.UTC maps years 0-99 to 19xx
  return d.toISOString().slice(0, 10) === iso;
}

/** A skip reason as plain text: links reduced to their text, code and emphasis marks dropped. */
function plainReason(reason) {
  return reason
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reads the comment of the `[~]` box on `lines[index]`.
 *
 * @param {{ text: string, fenced: boolean }[]} lines
 * @param {number} index
 * @returns {{ date: string | null, reason: string | null, problem: string | null }} the comment's
 *   date and plain-text reason when found, and the problem (null when the comment is valid)
 */
function readSkipComment(lines, index) {
  const marker = indentWidth(lines[index].text);
  const continuation = [];
  let j = index + 1;
  for (; j < lines.length; j += 1) {
    const { text, fenced } = lines[j];
    if (fenced || text.trim() === '' || LIST_ITEM.test(text) || indentWidth(text) <= marker) break;
    continuation.push(text.trim());
  }
  const m = SKIP_COMMENT.exec(continuation.join(' '));
  if (!m) {
    const missing = { date: null, reason: null };
    if (/Skipped on/.test(lines[index].text)) {
      return { ...missing, problem: `the skip comment is on the box line; move it to an indented continuation line: ${SKIP_COMMENT_FORMAT}` };
    }
    let k = j;
    while (k < lines.length && !lines[k].fenced && lines[k].text.trim() === '') k += 1;
    if (k > j && k < lines.length && !lines[k].fenced && /Skipped on/.test(lines[k].text)) {
      return { ...missing, problem: 'the skip comment is separated from the box by a blank line; put it on the line right after the box' };
    }
    return { ...missing, problem: `"[~]" needs a comment on an indented continuation line: ${SKIP_COMMENT_FORMAT}` };
  }
  const date = m[1].trim();
  const reason = plainReason(m[2]);
  if (!isCalendarDate(m[1])) {
    return { date, reason, problem: `skip date ${JSON.stringify(m[1])} is not a valid YYYY-MM-DD calendar date` };
  }
  if (reason.length < MIN_SKIP_REASON) {
    return {
      date,
      reason,
      problem: `skip reason ${JSON.stringify(reason)} has ${reason.length} characters; at least ${MIN_SKIP_REASON} are required`,
    };
  }
  return { date, reason, problem: null };
}

/** The state of a box marker character. */
function boxState(marker) {
  if (marker === ' ') return 'open';
  return marker === '~' ? 'skipped' : 'done';
}

/**
 * Lists the task-list boxes of a Markdown text in document order, ignoring fenced code blocks.
 * `text` is the rest of the box line after the marker, trimmed. A `skipped` box also carries
 * `skip`: its comment's date and plain-text reason (null when missing) and the comment problem
 * (null when the comment is valid).
 *
 * @param {string} markdown
 * @returns {{ line: number, state: 'open' | 'done' | 'skipped', text: string,
 *   skip?: { date: string | null, reason: string | null, problem: string | null } }[]}
 */
function readCheckboxes(markdown) {
  const boxes = [];
  const lines = markFences(markdown);
  lines.forEach(({ text, fenced }, i) => {
    const m = fenced ? null : CHECKBOX.exec(text);
    if (!m) return;
    const box = { line: i + 1, state: boxState(m[1]), text: text.slice(m[0].length).trim() };
    if (box.state === 'skipped') box.skip = readSkipComment(lines, i);
    boxes.push(box);
  });
  return boxes;
}

/**
 * Counts the task-list boxes of a Markdown text, ignoring fenced code blocks. `closed` is
 * `done + skipped`. Every `[~]` without a valid comment is reported in `problems` with its
 * 1-based line number.
 *
 * @param {string} markdown
 * @returns {{ total: number, open: number, done: number, skipped: number, closed: number,
 *   problems: { line: number, message: string }[] }}
 */
function countCheckboxes(markdown) {
  const counts = { total: 0, open: 0, done: 0, skipped: 0, closed: 0, problems: [] };
  for (const box of readCheckboxes(markdown)) {
    counts.total += 1;
    counts[box.state] += 1;
    if (box.state !== 'open') counts.closed += 1;
    if (box.skip && box.skip.problem) counts.problems.push({ line: box.line, message: box.skip.problem });
  }
  return counts;
}

module.exports = {
  MIN_SKIP_REASON,
  SKIP_COMMENT_FORMAT,
  countCheckboxes,
  isCalendarDate,
  markFences,
  plainReason,
  readCheckboxes,
};
