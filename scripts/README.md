# Scripts Directory

Helper scripts for the Lift-SDLC plugin, organized by audience.

## Directory Structure

```
scripts/
  skill/     Invoked by skills via prepare-script to pre-compute context
  ci/        CI validation and maintenance (run in GitHub Actions or locally)
  state/     State persistence CLIs for execute-plan and ship pipelines
  util/      Action utilities (worktree creation, ship init)
  lib/       Shared modules required by scripts above
```

### Naming Conventions

- **skill/** — named after the skill they serve (e.g., `commit.js` for commit-sdlc)
- **ci/** — prefixed with `validate-` for validators, otherwise descriptive
- **state/** — named after the pipeline they persist (e.g., `execute.js`, `ship.js`)
- **util/** — descriptive action names

## Skill-to-Script Mapping

| Skill | Scripts |
|-------|---------|
| commit-sdlc | `skill/commit.js` |
| jira-sdlc | `skill/jira.js` |
| plan-sdlc | `skill/plan.js` |
| pr-sdlc | `skill/pr.js` |
| received-review-sdlc | `skill/received-review.js` |
| review-sdlc | `skill/review.js` |
| setup-sdlc | `skill/setup.js`, `skill/guardrails.js` |
| version-sdlc | `skill/version.js` |
| execute-plan-sdlc | `state/execute.js`, `util/worktree-create.js` |
| ship-sdlc | `util/ship-init.js`, `skill/ship.js`, `state/ship.js` |

## Shared Modules (`lib/`)

| Module | Key Exports | Purpose |
|--------|-------------|---------|
| `config.js` | `readSection`, `writeSection`, `normalizePreset` | Read/write `.sdlc/config.json` sections |
| `dimensions.js` | `validateAll`, `extractFrontmatter` | Review dimension file validation |
| `discovery.js` | `validateAll`, `extractScriptRefs` | Plugin discovery and cross-reference checks |
| `git.js` | `exec`, `checkGitState`, `detectBaseBranch` | Git CLI wrappers |
| `openspec.js` | `detectActiveChanges`, `validateChange` | OpenSpec change detection |
| `output.js` | `writeOutput` | Structured JSON output helpers |
| `state.js` | `readState`, `writeState`, `initState` | Execution state file I/O |
| `stepper.js` | `parseArgs`, `createEnvelope`, `initState`, `transition`, `readState`, `writeState`, `addHistory`, `cleanupState` | Step-emitter protocol utilities (envelope creation, state lifecycle, CLI parsing) |
| `version.js` | `detectVersionFile`, `readVersion`, `computeNextVersions` | Semantic versioning utilities |

## Script Resolution

Skills locate scripts using a two-step pattern:

```bash
# 1. Installed plugin (find in plugin cache)
SCRIPT=$(find ~/.gemini/config/plugins -name "<name>.js" -path "*/sdlc*/scripts/<subdir>/<name>.js" 2>/dev/null | sort -V | tail -1)

# 2. Development fallback (relative to repo root)
[ -z "$SCRIPT" ] && [ -f "plugins/lift-sdlc/scripts/<subdir>/<name>.js" ] && SCRIPT="plugins/lift-sdlc/scripts/<subdir>/<name>.js"
```

All scripts use `__dirname`-based resolution for `lib/` imports:

```js
const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');
const { readSection } = require(path.join(LIB, 'config'));
```

## CLI contract

Every CLI script under `scripts/**/*.js` follows three rules:

- **Help before I/O**: `--help`/`-h` prints usage and exits before the script touches stdin, the filesystem, or any other I/O — even when a parent process (e.g. an agent harness) holds the script's stdin pipe open and never closes it.
- **Reject unknown flags**: an unrecognized flag for a (sub)command exits with code `2` and a message naming the flags that command accepts, rather than being silently ignored.
- **`HELP_CONTRACT` allowlist**: a script that additionally promises a real, human-readable `Usage:` line (matching `/^Usage:/m`) and exit code `0` on `--help` must be added to the `HELP_CONTRACT` set. Every other enumerated script only promises termination on `--help` — it may exit non-zero, but must not hang or die by signal.

These rules are enforced by `scripts/ci/cli-help-contract.test.js`, which spawns every CLI script under `scripts/` with `--help` against an open, never-ended stdin pipe and a fresh temp `cwd`, then asserts the process terminates without hanging or dying by signal (and, for scripts in `HELP_CONTRACT`, that it exits `0` and prints a `Usage:` line).
