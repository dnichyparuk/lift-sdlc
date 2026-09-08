'use strict';

/**
 * stepper.js
 * Shared step-emitter utility library for SDLC skill scripts.
 *
 * Provides the universal two-call protocol: scripts emit one step at a time,
 * the LLM executes each step, and calls the script again with the result.
 * The script controls workflow sequencing; the LLM provides domain knowledge.
 *
 * Zero npm dependencies — Node.js built-ins only.
 */

const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse step-emitter CLI arguments from process.argv.
 *
 * Recognizes:
 *   --after <step_id>        Step that was just executed
 *   --result <json>          Result JSON string (inline)
 *   --result-file <path>     Result JSON file path (preferred for large payloads)
 *   --state <state_file>     Path to accumulated state file
 *
 * All other argv entries are returned in `rest` for skill-specific parsing.
 *
 * @returns {{ after: string|null, result: object|null, stateFile: string|null, rest: string[] }}
 */
function parseArgs() {
  const argv = process.argv.slice(2);
  let after = null;
  let result = null;
  let stateFile = null;
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--after':
        after = argv[++i] || null;
        break;
      case '--result':
        try { result = JSON.parse(argv[++i]); }
        catch (_) { result = null; }
        break;
      case '--result-file': {
        const filePath = argv[++i];
        if (filePath) {
          try { result = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
          catch (_) { result = null; }
        }
        break;
      }
      case '--state':
        stateFile = argv[++i] || null;
        break;
      default:
        rest.push(argv[i]);
    }
  }

  return { after, result, stateFile, rest };
}

// ---------------------------------------------------------------------------
// Envelope creation
// ---------------------------------------------------------------------------

/**
 * Build a universal output envelope.
 *
 * @param {"step"|"done"|"error"} status
 * @param {object|null} step  Step descriptor (required when status is "step")
 *   @param {string} step.id       Unique step identifier
 *   @param {string} step.action   Human-readable instruction for the LLM
 *   @param {string[]} [step.tool_hints]  Tools the LLM will likely need
 *   @param {object} [step.data]   Pre-computed data for this step
 * @param {object} [options]
 *   @param {object|null} [options.llmDecision]   Decision the LLM must make
 *   @param {string|null} [options.stateFile]     Path to state file
 *   @param {{ completed: number, total: number }} [options.progress]
 *   @param {object} [options.ext]  Skill-specific extension fields
 *   @param {string} [options.error]  Error message (when status is "error")
 * @returns {object} Universal envelope
 */
function createEnvelope(status, step, options = {}) {
  const envelope = {
    status,
    step: step || null,
    llm_decision: options.llmDecision || null,
    state_file: options.stateFile || null,
    progress: options.progress || null,
    ext: options.ext || {},
  };

  if (status === 'error' && options.error) {
    envelope.error = options.error;
  }

  return envelope;
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

/**
 * Generate a unique temporary file path for state storage.
 *
 * @param {string} skill  Skill name used as filename prefix
 * @returns {string} Absolute path to a new temp file
 */
function createStateFile(skill) {
  const hash = crypto.randomBytes(6).toString('hex');
  return path.join(os.tmpdir(), `${skill}-${hash}.json`);
}

/**
 * Read and parse a state file.
 *
 * @param {string} stateFile  Absolute path to the state file
 * @returns {object} Parsed state
 * @throws {Error} If file does not exist or contains invalid JSON
 */
function readState(stateFile) {
  const raw = fs.readFileSync(stateFile, 'utf8');
  return JSON.parse(raw);
}

/**
 * Write state to a file (atomic write via temp + rename).
 *
 * @param {string} stateFile  Absolute path to the state file
 * @param {object} state      State object to persist
 */
function writeState(stateFile, state) {
  const dir    = path.dirname(stateFile);
  const suffix = crypto.randomBytes(4).toString('hex');
  const tmp    = path.join(dir, path.basename(stateFile) + '.' + suffix + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, stateFile);
}

/**
 * Append a completed step to the state history array.
 *
 * @param {object} state   State object (must have a `history` array)
 * @param {string} stepId  The step.id that was executed
 * @param {object} result  The result envelope from the LLM
 */
function addHistory(state, stepId, result) {
  if (!Array.isArray(state.history)) {
    state.history = [];
  }
  state.history.push({
    step: stepId,
    result: result.success !== undefined ? (result.success ? 'success' : 'failed') : 'unknown',
    data: result.output || {},
    timestamp: new Date().toISOString(),
  });
}

/**
 * Clean up (delete) a state file. Silently ignores missing files.
 *
 * @param {string} stateFile  Absolute path to the state file
 */
function cleanupState(stateFile) {
  try { fs.unlinkSync(stateFile); } catch (_) { /* ignored */ }
}

// ---------------------------------------------------------------------------
// Convenience: initial state scaffold
// ---------------------------------------------------------------------------

/**
 * Create and persist an initial state object for a skill.
 *
 * @param {string} skill     Skill name (e.g., "commit-sdlc")
 * @param {object} [extra]   Additional fields to merge into the initial state
 * @returns {{ state: object, stateFile: string }}
 */
function initState(skill, extra = {}) {
  const stateFile = createStateFile(skill);
  const state = {
    skill,
    started_at: new Date().toISOString(),
    current_step: null,
    history: [],
    ext: {},
    ...extra,
  };
  writeState(stateFile, state);
  return { state, stateFile };
}

// ---------------------------------------------------------------------------
// Convenience: step transition helper
// ---------------------------------------------------------------------------

/**
 * Process a step transition: read state, add history, update current step,
 * persist, and return the updated state. Combines the common pattern of
 * readState + addHistory + writeState into a single call.
 *
 * @param {string} stateFile   Path to state file
 * @param {string} afterStepId The step.id that was just completed
 * @param {object} result      The result envelope from the LLM
 * @param {string} nextStepId  The next step.id (set as current_step)
 * @returns {object} Updated state
 */
function transition(stateFile, afterStepId, result, nextStepId) {
  const state = readState(stateFile);
  addHistory(state, afterStepId, result);
  state.current_step = nextStepId;
  writeState(stateFile, state);
  return state;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  parseArgs,
  createEnvelope,
  createStateFile,
  readState,
  writeState,
  addHistory,
  cleanupState,
  initState,
  transition,
};
