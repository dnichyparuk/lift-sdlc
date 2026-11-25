'use strict';

/**
 * hook-context.js
 * Shared stdin parsing, workspace resolution, and official Antigravity CLI
 * hook output helpers.
 *
 * Antigravity executes plugin hooks with OS cwd = <dir containing hooks.json>,
 * passing the user's workspace in stdin.cwd / stdin.workspacePaths[0].
 * Always pass `workspaceCwd` into git/state/config helpers instead of relying
 * on process.cwd().
 */

const fs = require('node:fs');

/**
 * Read and parse hook stdin payload and resolve the workspace directory.
 * @param {object} [opts]
 * @param {boolean} [opts.failClosed=false]  If true, return { ok: false } on JSON parse error.
 * @returns {{ ok: boolean, input: object, workspaceCwd: string, error?: string }}
 */
function readHookContext({ failClosed = false } = {}) {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (err) {
    if (failClosed) {
      return { ok: false, input: {}, workspaceCwd: process.cwd(), error: err.message };
    }
    return { ok: true, input: {}, workspaceCwd: process.cwd() };
  }

  let input = {};
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        input = parsed;
      } else if (failClosed) {
        return { ok: false, input: {}, workspaceCwd: process.cwd(), error: 'Hook stdin JSON is not an object' };
      }
    } catch (err) {
      if (failClosed) {
        return { ok: false, input: {}, workspaceCwd: process.cwd(), error: err.message };
      }
    }
  }

  const workspaceCwd =
    (typeof input.cwd === 'string' && input.cwd.trim()) ||
    (Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string' && input.workspacePaths[0].trim()) ||
    process.cwd();

  return { ok: true, input, workspaceCwd };
}

/**
 * Format an Antigravity CLI systemMessage hook response per hooks.md contract
 * (`{ injectSteps: [{ systemMessage: { systemMessage: string } }] }`).
 * @param {string} text
 * @returns {{ injectSteps: Array<{ systemMessage: { systemMessage: string } }> }}
 */
function formatSystemMessage(text) {
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: String(text),
        },
      },
    ],
  };
}

module.exports = {
  readHookContext,
  formatSystemMessage,
};
