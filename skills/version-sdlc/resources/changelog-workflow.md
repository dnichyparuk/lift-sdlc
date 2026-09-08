### Branch C: Changelog-Update Workflow (`flow === "changelog-update"`)

This branch activates when `/version-sdlc --changelog` is run without a bump type.
It updates the CHANGELOG entry for the **already-tagged current version** — useful after
squash merges add commits that weren't captured when the release was originally tagged.

### Step 1 (CONSUME): Read the Context

Read `VERSION_CONTEXT_JSON`. Extract:

| Field | Description |
| ----- | ----------- |
| `currentVersion` | The current version string (e.g. `1.2.3`) |
| `currentTag` | The git tag for the current version (e.g. `v1.2.3`) |
| `previousTag` | The tag immediately before the current one (e.g. `v1.2.2`), or `null` for the first release |
| `commits` | Commits between `previousTag` and `currentTag` — the actual commits that make up this release |
| `commits[].ticketIds` | Ticket IDs extracted from each commit |
| `changelog.exists` | Whether `CHANGELOG.md` exists |
| `changelog.filePath` | Path to the changelog file |
| `changelog.currentContent` | Current content of the changelog (truncated to 5000 chars) |
| `config.ticketPrefix` | Optional ticket prefix for filtering ticket IDs |
| `flags.noPush` | Whether to skip pushing |
| `flags.auto` | Whether `--auto` was passed — skip interactive approval |

### Step 2 (CHECK): Validate Preconditions

- If `commits.length === 0`: inform the user `"No commits found between ${previousTag} and ${currentTag}. The changelog may already be up to date."` and stop.
- If `changelog.exists === false`: inform the user that no CHANGELOG.md was found and offer to create one: `"CHANGELOG.md does not exist. Run /version-sdlc patch --changelog to create it as part of a release, or confirm to create it now with just the current version entry."` Ask yes/no.

### Step 3 (PLAN): Draft Updated Changelog Entry

Draft an updated `## [currentVersion]` changelog entry from the commits between `previousTag` and `currentTag`:

- Use the same commit-type mapping as Branch B Step 2 (`feat` → **Added**, `fix` → **Fixed**, etc.)
- Apply the same ticket ID rules as Branch B Step 2 (append when `config.ticketPrefix` is set)
- If an existing `## [currentVersion]` section is present in `changelog.currentContent`:
  - Compare the existing entries against the commits
  - Keep entries that are still accurate
  - Add entries for commits not yet represented
  - Remove entries that cannot be traced to any commit in the `commits` array (they may be fabricated or from squashed commits that are no longer visible)
  - **Preserve user-edited entries** — if an entry looks hand-written (not matching a commit description directly), keep it with a note
- If no existing entry: draft fresh from the commits

### Step 4 (CRITIQUE): Self-review

Apply the same quality gates as Branch B: no fabricated entries, all user-facing commits represented, changelog completeness.

### Step 5 (IMPROVE): Revise Based on Critique

Fix any issues found in Step 4.

### Step 6 (PRESENT): Show the User

Display side-by-side (or sequentially with clear labels):

```
Existing changelog entry for [currentVersion]:
──────────────────────────────────────────────
[show existing ## [currentVersion] section, or "(none)" if no existing entry]

Updated changelog entry:
──────────────────────────────────────────────
[show the new draft entry]

What changed: [brief summary of additions/removals]
```

Use AskUserQuestion to ask:
> Proceed with this changelog update?

Options:
- **yes** — apply the update
- **edit** — tell me what to change
- **cancel** — abort

If the user chooses **edit**, ask what to change, revise, and present again. Loop until explicit **yes** or **cancel**.

**Auto mode:** When `flags.auto` is true, skip the AskUserQuestion prompt entirely. Still display the existing vs. updated changelog comparison for visibility, then proceed directly to Step 7. Treat the response as an implicit `yes`.

### Step 7 (EXECUTE): Apply the Update

On `yes`:

1. If `changelog.exists === false`: create CHANGELOG.md with a standard header + the new entry.
2. If the `## [currentVersion]` section exists in the changelog: use the Edit tool to replace it with the updated entry.
3. If the `## [currentVersion]` section does not exist yet: prepend the entry after the `## [Unreleased]` section (if present) or after the file header.
4. Stage, commit and push the changelog in one scripted step:

   ```shell
   node "<PLUGIN_ROOT>/scripts/util/version-execute.js" changelog-commit --tag <currentTag> --changelog-file <changelog.filePath>
   ```

   > **Contract (Input/Output):**
   > - **Input**: `--tag <currentTag>` (drives the `docs: update changelog for <tag>` commit subject), `--changelog-file <path>` (defaults to `CHANGELOG.md`), `--no-push` when `flags.noPush === true`.
   > - **Output**: one JSON line — `{"status":"ok"}` on success (plus `"pushed":false` under `--no-push`), or `{"status":"failed","failedStep":"add"|"commit"|"push","reason":"..."}`, with additive `committed: true` / `pushed: false` when the commit landed but the push failed.

   Branch on the result:
   - `{"status":"ok", ...}` — continue to the result display.
   - `{"status":"failed","failedStep":"push","committed":true, ...}` — the commit landed locally and only the push failed. Show `reason` and tell the user to push manually once the cause is resolved.
   - `{"status":"failed", ...}` with any other `failedStep` — nothing was committed. Show `reason` and stop.

**Do NOT create a new tag.** This workflow only updates the changelog — `changelog-commit` creates none.

Display result:
```
✓ Changelog updated for ${currentTag}.
  Commit: abc1234 — docs: update changelog for v1.2.3
  Pushed: yes → origin/main
```

### Accuracy and limitations

The automated changelog is a **draft, not a source of truth**. Correctness is the developer's responsibility. The tooling makes changelog maintenance fast, but cannot guarantee accuracy in all workflows.

#### Known Limitations

| Limitation | Why it happens | Impact |
|---|---|---|
| **Squash merge loses commit granularity** | Squash-merge collapses N commits into 1. After retag, `previousTag..currentTag` on main sees only the squash commit. | Changelog drafted on the feature branch reflects individual commits; after squash, that detail no longer exists in main's git history. |
| **Post-tag commits not in changelog** | Commits added after tagging but before merge (e.g. code review fixes). | These changes are released but not documented in the original changelog entry. |
| **Parallel branches / merge order** | Multiple feature branches tag releases concurrently. Merge order determines which squash commit each tag lands on after retag. | Tag may end up on a different commit than intended; changelog was written against a different commit range. |
| **Conventional commit compliance** | Changelog quality depends on developers writing `feat:`, `fix:`, etc. Non-conforming commits show as "other" and may be skipped. | Incomplete or inaccurate changelog entries. |
| **LLM-drafted content** | The changelog entry is generated by an LLM from commit data and may misinterpret scope or miss nuances. | Entries require human review before they are authoritative. |

#### Mitigation: 4-Layer Defense

1. **CI validates presence** — `check-changelog.cjs` (scaffolded during init when changelog is enabled) fails on push to main if no `## [version]` heading exists. Ensures at least a placeholder entry.
2. **Run `/version-sdlc --changelog` on `main` after a squash-merge** — It re-derives the changelog from the actual `previousTag..currentTag` range (not the feature branch), shows a diff against the existing entry, and lets you approve or edit the update without creating a new tag.
3. **Retag script advisory** — After retagging, `retag-release.cjs` prints a warning if `changelog: true` and no entry exists for the tag. Reminds developers to verify.
4. **Manual review** — Before release communications, treat the CHANGELOG as a draft to review, not a finished document.
