### Branch A: Init Workflow (`flow === "init"`)

### Step 1 (CONSUME): Read the Context

Read `VERSION_CONTEXT_JSON`. Extract:

- `detectedVersionFile` — path to the detected version file (e.g. `package.json`)
- `currentVersion` — version string found in that file or from git tags
- `existingTags` — list of existing git release tags
- `tagConvention` — detected tag prefix (e.g. `v`, `release/`, or empty)
- `suggestedConfig` — the config object that will be written to `.sdlc/config.json → version section`

### Step 2 (PRESENT): Show Detected Setup

Display the detected configuration in a clean summary table:

```
Detected setup:
  Mode:         file
  Version file: package.json
  Version:      1.2.3
  Tag prefix:   v
  Changelog:    no (use --changelog flag to enable per release)

Suggested config:
  .sdlc/config.json → version section — will be written
```

### Step 3 (CONFIRM): Ask User to Confirm

Use AskUserQuestion to present the detected setup and ask:
> Does this look right?

Options:
- **yes** — write version section to .sdlc/config.json
- **tag-only** — use git tags as version source (no version file)
- **changelog** — same as yes, but enable changelog by default
- **cancel** — abort setup

### Step 4 (WRITE): Write Config on Confirmation

On `yes` or `changelog`, write the version section to `.sdlc/config.json` using `writeSection` from lib/config.js with
the content from `suggestedConfig` (adjusted if `changelog` was chosen).

Then scaffold CI scripts and workflows using `scaffold-ci.js`:

```shell
<PLUGIN_ROOT>/skills/setup-sdlc/scripts/init-workflow_scaffold.sh
```

Run the scaffold (include `--changelog` when `config.changelog === true`):

```bash
# Without changelog:
SCAFFOLD_OUTPUT_FILE=$(node "$SCRIPT" --output-file)
# With changelog:
SCAFFOLD_OUTPUT_FILE=$(node "$SCRIPT" --changelog --output-file)
```

Read the JSON output. For each file in the `files` array:
- `action: "created"` → show `✓ <path> added (<description>).`
- `action: "skipped"` → show `✓ <path> (already exists — skipped).`

Display:

```
✓ .sdlc/config.json → version section written.
✓ .github/workflows/retag-release.yml added (auto-fixes tags after squash merge to main).
✓ .github/scripts/retag-release.cjs added.
✓ .github/workflows/check-changelog.yml added (validates changelog entry exists after each push to main).
✓ .github/scripts/check-changelog.cjs added.
Run /version-sdlc patch to create your first release.
```

The check-changelog lines are only shown when `config.changelog === true`.

**Version check** — after scaffolding, check if any installed files are outdated. Run the scaffold script again in check-only mode:

```bash
CHECK_OUTPUT_FILE=$(node "$SCRIPT" --check-only --output-file)
# With changelog:
CHECK_OUTPUT_FILE=$(node "$SCRIPT" --check-only --changelog --output-file)
```

Read the JSON output. If any files have `action: "outdated"`:

```
⚠  Outdated CI files detected:
   .github/scripts/retag-release.cjs   (installed: v<N>, current: v<M>)

Update these files? (yes / no)
```

On `yes`, run `node "$SCRIPT" --force` (add `--changelog` if applicable) to overwrite the outdated files. On `no`, warn:
```
⚠  Skipped update. Outdated CI scripts may miss bug fixes or new features.
```

On `tag-only`, update `suggestedConfig.mode` to `"tag"` before writing. Apply the same workflow scaffolding.

On `cancel`, stop immediately without writing any files.
