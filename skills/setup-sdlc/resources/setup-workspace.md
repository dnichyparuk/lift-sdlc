# Workspace Sub-Flow

<!-- Fixes #351. -->

The `workspace` section (`.sdlc/local.json` → `workspace.worktree`) uses the
generic 3.G field-loop dispatcher (`delegatedTo: null`, fields from
`scripts/lib/workspace-fields.js::WORKSPACE_FIELDS`), but the `layout` field
requires a numbered menu with live previews and a mismatch warning before the
AskUserQuestion fires. The augmentations below override the default 3.G
rendering for this section only; all other 3.G rules (skip gates, answer
mapping, etc.) still apply.

---

## Pre-computed context

The workspace section row carries a `context` object populated by the prepare
script (`scripts/skill/setup.js` → `scripts/lib/workspace-context.js`). It is
the single source of truth for menu rendering; do not recompute previews or
mismatches from the SKILL.

- `previews.inside`, `previews.sibling`, `previews.central` — sample resolved paths
  using a sentinel branch (`example-feature`) for each deterministic layout.
- `antigravityIgnored` — boolean; whether the project root `.gitignore` already lists `.sdlc/`.
- `mismatchesByLayout.{inside|sibling|central}` — list of existing worktree paths
  under `git worktree list` that do NOT match the layout being considered. Non-empty
  values mean picking that layout would leave the listed worktrees orphaned (still
  usable, but outside the configured location).
- `existingWorktrees` — full output of `listExistingWorktrees()` for diagnostics.

## Layout field rendering — overrides default 3.G behavior

1. **Numbered layout menu, printed as plain chat output (NOT `AskUserQuestion`)
   before the question.** Use the help text returned by
   `workspace-fields.js::layoutField.help({ repoRoot, repoName, home, antigravityIgnored })`
   — it already renders previews 1–3 with their resolved paths and emits the
   `.sdlc/` gitignore note based on `context.antigravityIgnored`. Append a fourth row
   for `template` with the static description from the field's `options[3]`.

   Example shape (the script supplies the exact strings):

   ```
   Where should sdlc create git worktrees?
     1. inside    <preview.inside>
     2. sibling   <preview.sibling>
     3. central   <preview.central>
     4. template  Custom path with placeholders (advanced)
   ```

2. **Then dispatch the AskUserQuestion for the `layout` field** as in 3.G —
   `field.label`, helper text from `field.description`, options
   `inside | sibling | central | template`, default `inside`. Validate via
   `field.validate(answer)` and re-prompt on failure.

3. **Mismatch warning — runs after the layout answer arrives, before any
   follow-up field is prompted.** When the chosen layout L is one of
   `inside | sibling | central` AND `context.mismatchesByLayout[L]` is non-empty,
   print one warning line per existing worktree path so the user knows the new
   layout will not relocate them:

   ```
   warning: existing worktree at <path> does not match selected layout=<L>.
   It will remain where it is; only future worktrees will use the new layout.
   ```

   Do NOT block — the wizard always proceeds. The warning is informational. The
   check is skipped for `template` layout (custom paths are user-defined and
   cannot be classified deterministically).

## Conditional follow-up fields per layout

After the layout answer (and any mismatch warning), iterate `WORKSPACE_FIELDS`
in array order and dispatch one AskUserQuestion per field that is relevant for
the chosen layout. Fields use the field's `description` from
`workspace-fields.js` as helper text (verbatim — do not paraphrase). When a
field defines `validate(value, layout, repoContext)`, re-prompt on failure
with the exception message inline.

| Layout | Follow-up fields prompted | Notes |
|---|---|---|
| `inside` | `base` (optional), `ensureGitignore` (boolean, default `true`), `nameTemplate` (optional) | `ensureGitignore=true` enables the SessionStart hook to auto-add `.sdlc/worktrees/` to root `.gitignore`. |
| `sibling` | `base` (optional), `nameTemplate` (optional) | Path resolves alongside the repo dir. |
| `central` | `base` (optional), `nameTemplate` (optional) | Default places under `~/.sdlc/worktrees/<repoName>/`. |
| `template` | `template` (required — must contain `{slug}` or `{branch}`), `nameTemplate` (optional) | Skip `base` and `ensureGitignore`. |

Skip a follow-up field entirely (do NOT prompt) when the chosen layout makes it
irrelevant (e.g., `template` field for non-`template` layouts; `ensureGitignore`
for non-`inside` layouts).

## Live preview for `template`

When the user enters a `template` value, call
`templateField.preview(value, repoContext)` to render the resolved path using
the sentinel branch. Print the preview line so the user can confirm before
moving to the next field:

```
Template: <user-input>
Preview with sentinel branch `example-feature`:
  <resolved-path>
```

If the preview throws (template missing required placeholders, `..` traversal,
etc.), surface the exception message and re-prompt for the template field.

## Writing the section to `.sdlc/local.json`

Assemble the section object, omitting any field the user left blank —
`lib/config.js::writeLocalConfig` does read-merge-write so unspecified fields
are preserved:

```json
{ "workspace": { "worktree": { "layout": "<L>", ...optional fields the user set } } }
```

Store the assembled object under the `workspace` key for the "Writing config
files" step in `SKILL.md`. The config lands in `.sdlc/local.json` (gitignored,
per-developer) — never in `.sdlc/config.json`.

---

## See Also

- [`/setup-sdlc`](../SKILL.md) — parent skill; Step 3 dispatch table routes the `workspace` section here
- `scripts/lib/workspace-fields.js` — field definitions, validators, previews
- `scripts/lib/workspace-context.js` — pre-computed preview/mismatch context
