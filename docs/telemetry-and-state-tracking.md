# Telemetry and State Tracking

This document describes Lift-SDLC's built-in state tracking and session management system.

## Overview

The plugin has **local-only** state tracking—no external data collection or analytics services. The "telemetry" mentioned in the README refers to internal helper scripts that track pipeline state locally for recovery and resume functionality.

## Components

### 1. Session Hooks

Defined in [hooks.json](../hooks.json), these run at different lifecycle events:

#### `session-start.js` (PreInvocation Hook)
**Location**: `hooks/session-start.js`

Runs when a session starts and outputs context information:
- Plugin version & skill count
- Active pipeline state (ship/execute)
- Compact recovery info (restores state after context compaction)
- Git status, OpenSpec changes, Jira cache status
- Pipeline resume detection

**Key Features**:
- Detects source of invocation: `startup`, `clear`, `compact`, or `resume`
- Emits different output for `compact` vs other sources to enable implicit resume
- Reads state files to determine active pipelines
- Cleans up stale recovery files (>24 hours old)

#### `stop-state-save.js` (Stop Hook)
**Location**: `hooks/stop-state-save.js`

Saves pipeline state when Antigravity finishes responding:
- Creates `.sdlc/execution/.compact-recovery-<branch>.json` files
- Safety net for session crashes between compactions
- Per-branch recovery files (issue #256)

**State Captured**:
- Pipeline type (ship-sdlc or execute-plan-sdlc)
- Current branch
- Current step/wave progress
- Review verdicts and deferred findings
- Pipeline flags (preset, auto, skip)

#### Guard Hooks
- **`pre-tool-git-guard.js`**: Validates git operations before execution
- **`pre-tool-validate.js`**: Validates file write operations

### 2. Execution State Files

**Module**: `scripts/lib/state.js`

Pipeline progress is persisted in `.sdlc/execution/` directory (main worktree).

#### File Naming Convention
```
<prefix>-<branchSlug>-<timestamp>.json
```

Examples:
- `ship-main-1698765432.json` (release pipeline on main branch)
- `execute-feat-auth-1698765433.json` (plan execution on feat/auth branch)

#### State File Structure

**Ship Pipeline State**:
```json
{
  "branch": "main",
  "steps": [
    {
      "id": "review",
      "name": "Review Changes",
      "status": "completed",
      "output": {
        "verdict": "approved",
        "deferredFindings": 0
      }
    }
  ],
  "flags": {
    "preset": "standard",
    "auto": false,
    "skip": []
  }
}
```

**Execute Pipeline State**:
```json
{
  "branch": "feat/new-feature",
  "waves": [
    {
      "id": 1,
      "status": "completed",
      "tasks": [...]
    }
  ],
  "preset": "standard"
}
```

#### Key Functions

- **`slugifyBranch(branch)`**: Converts branch names to filesystem-safe slugs
  - Example: `feat/my-feature` → `feat-my-feature`

- **`resolveStateDir()`**: Returns canonical state directory
  - Always resolves to main worktree: `<mainWorktree>/.sdlc/execution/`
  - All worktrees share the same state files

- **`findStateFile(prefix, branchSlug)`**: Finds most recent state file
  - Returns newest file matching pattern by mtime

- **`readState(prefix, branchSlug)`**: Reads state file content

- **`writeState(prefix, branchSlug, data)`**: Writes state atomically

- **`detectResumeState(opts)`**: Detects resumable pipeline state

#### Compact Recovery

**TTL**: 1 hour (`COMPACT_RECOVERY_TTL_MS = 3600000`)

Recovery files are:
- Created by `stop-state-save.js` hook
- Consumed by `session-start.js` hook after compaction
- Cleaned up when stale (>24 hours old)
- Per-branch to avoid conflicts

### 3. Budget Tracking

**Module**: `scripts/lib/dispatch-budget.js`

Calculates context/token budget to determine concurrent task limits.

#### Model Context Limits
Using 75% of context for inputs, 25% reserved for reasoning:

| Model | Input Limit | Byte Budget |
|-------|-------------|-------------|
| gemini-3.5-flash (all variants) | 1M tokens | ~3M bytes |
| gemini-3.1-pro (all variants) | 1M tokens | ~3M bytes |

#### Static Cap Table
Progressive caps based on total remaining tasks:

| Total Tasks | Max Concurrent |
|-------------|----------------|
| 1-3 | No limit |
| 4-8 | 4 |
| 9-15 | 5 |
| 16+ | 6 |

#### Budget Computation

**Function**: `computeWaveBudget(opts)`

**Inputs**:
- `templateBytes`: Prompt template scaffolding size
- `guardrailsBytes`: Rendered guardrails block size
- `perTaskFactSheetBytes`: Array of fact-sheet sizes per task
- `priorWaveContextBytes`: Prior-wave context summary size
- `model`: Model identifier
- `totalRemainingTasks`: Total tasks left in pipeline

**Algorithm**:
1. Calculate fixed bytes: template + guardrails + prior context
2. Calculate available bytes: model limit - fixed bytes
3. Sort fact-sheet sizes ascending (bin-packing)
4. Pack tasks until budget exhausted or static cap reached
5. Guarantee minimum 1 task if candidates exist

**Returns**:
```javascript
{
  maxConcurrentTasks: number,    // How many tasks to dispatch
  perTaskCeiling: number,        // Average bytes per task
  totalReservedBytes: number     // Total bytes consumed
}
```

### 4. Output Protocols

**Module**: `scripts/lib/output.js`

Two complementary output protocols:

#### LLM-Skill Manifest Protocol
**Function**: `writeOutput(data, prefix, exitCode)`

- Writes JSON to randomized temp file under `os.tmpdir()`
- Prints only file path to stdout
- Used by prepare-scripts for large structured payloads
- Consumed by SKILL.md via `--output-file` parameter

**Example Flow**:
```javascript
writeOutput({ tasks: [...] }, 'plan-context');
// Writes: /tmp/plan-context-a3f9b2c1.json
// Stdout: /tmp/plan-context-a3f9b2c1.json
```

#### Streaming/Polling Protocol
**Functions**: 
- `writeJsonLine(obj, opts)`: Single JSON line to stdout
- `emitText(string, exitCode)`: Raw text to stdout

Used by:
- `await-remote-review.js`: Streaming verdict updates
- `verify-pipeline.js`: CI status polling
- CLI consumers that parse stdout directly

**Options**:
```javascript
writeJsonLine({ status: 'success' }, { exitCode: 0, indent: 2 });
```

## State Lifecycle

### Pipeline Initialization
1. Skill invoked (e.g., `/execute-plan-sdlc`)
2. Prepare script runs, computes context
3. State file created: `execute-<branch>-<timestamp>.json`
4. Initial state written with empty waves/steps

### During Execution
1. Agent processes tasks/steps
2. State updated after each completion
3. Atomic writes via temp file + rename
4. Stop hook saves compact recovery on each turn

### After Compaction
1. Context compacted to save tokens
2. Compact recovery file consumed by session-start
3. Pipeline state re-injected into prompt
4. Execution continues from saved position

### Cleanup
1. Session-start hook removes stale recovery files (>24h)
2. Legacy `.compact-recovery.json` cleaned up (pre-#256 format)
3. Old state files remain for audit trail

## Resume Patterns

### Ship Pipeline Resume
Detected by `session-start.js`:
```
Active pipeline: ship-sdlc on main (paused at step 3: publish)
  Resume with: /ship-sdlc --resume
```

### Execute Pipeline Resume
Two formats depending on matcher source:

**Startup/Clear/Resume** (byte-stable for prompt cache):
```
Active execution: execute-plan-sdlc on feat/auth (wave 2 of 5 complete)
  Resume with: /execute-plan-sdlc --resume
```

**Post-Compact** (implicit resume signal):
```
Active execution (post-compact): execute-plan-sdlc on feat/auth (wave 2 of 5 complete)
  Resume with: /execute-plan-sdlc --resume
```

The distinction enables execute-plan-sdlc Step 0 to treat post-compact as implicit `--resume`.

## File Locations

### State Files
- **Directory**: `<mainWorktree>/.sdlc/execution/`
- **Format**: `<prefix>-<branchSlug>-<timestamp>.json`
- **Shared**: All worktrees use main worktree state directory

### Recovery Files
- **Directory**: `<mainWorktree>/.sdlc/execution/`
- **Format**: `.compact-recovery-<branchSlug>.json`
- **Per-branch**: One recovery file per active branch (issue #256)

### Output Files
- **Directory**: `os.tmpdir()` (typically `/tmp`)
- **Format**: `<prefix>-<randomHash>.json`
- **Lifetime**: Temporary, cleaned by OS

## What's NOT Tracked

✗ **No external analytics or telemetry services**  
✗ **No usage data sent anywhere**  
✗ **No network calls for tracking**  
✗ **No personal data collection**  
✗ **No metrics dashboards**

All state tracking is:
- ✓ Local filesystem only
- ✓ Per-repository isolation
- ✓ Deterministic and inspectable
- ✓ Used solely for recovery/resume

## Configuration

### Whitelisting Scripts

To prevent repeated permission prompts, add to `~/.gemini/antigravity-cli/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "command(node .*/\\.gemini/config/plugins/.*)",
      "command(.*/\.gemini/config/plugins/lift-sdlc/skills/.*/scripts/.*)"
    ]
  }
}
```

### Environment Overrides

**`SDLC_STATE_DIR_OVERRIDE`**: Override state directory for testing
```bash
export SDLC_STATE_DIR_OVERRIDE=/tmp/test-fixtures/.sdlc/execution/
```

## Debugging

### View Current State
```bash
# Ship pipeline state
cat .sdlc/execution/ship-$(git branch --show-current | tr '/' '-')-*.json | jq .

# Execute pipeline state
cat .sdlc/execution/execute-$(git branch --show-current | tr '/' '-')-*.json | jq .
```

### Check Recovery Files
```bash
# View compact recovery
cat .sdlc/execution/.compact-recovery-*.json | jq .

# List all state files
ls -lht .sdlc/execution/
```

### Hook Output
Session hooks output to the system-reminder context. To see what they emit:
```bash
# Simulate session-start
echo '{"hook_event_name":"SessionStart","source":"startup"}' | node hooks/session-start.js

# Simulate stop-state-save
node hooks/stop-state-save.js
```

## Related Issues

- **#256**: Per-branch compact recovery files
- **#359**: Compact recovery TTL implementation
- **#360**: Main-worktree-rooted resolution (R-projectroot)
- **#392**: Session-start matcher source (R36)
- **#432**: Byte-budget computation (R-BYTE-BUDGET)

## See Also

- [SDLC Plugin Architecture Report](./sdlc-plugin-architecture-report.md): Overview of the four-layer architecture
- [Scripts README](../scripts/README.md): Overview of all helper scripts
- [Plugin README](../README.md): General plugin documentation
- [hooks.json](../hooks.json): Hook registration definitions
