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
