---
name: pr-sdlc
description: "Use this skill when creating or updating a pull request, updating a PR description, or generating PR content from commits and diffs. Handles the full PR workflow: consumes pre-computed context from skill/pr.js, generates description with plan-critique-improve-do-critique-improve, user review, and gh CLI execution. Auto-labels PRs based on context signals (branch, commits, diff, Jira) with mandatory approval. Arguments: [--draft] [--update] [--base <branch>] [--auto] [--label <name>]. Use --auto to skip interactive approval. Triggers on: create PR, open pull request, update PR, write PR description, PR summary, describe changes for a pull request."
user-invocable: true
argument-hint: "[--draft] [--update] [--base <branch>] [--auto] [--label <name>]"
---

# Creating Pull Requests

When to use: creating or updating a PR for the current branch; `/pr` delegates here.
Consume pre-computed git context from `skill/pr.js` and generate a PR description readable by technical and non-technical stakeholders.

**Announce at start:** "I'm using pr-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder (omit parenthetical if absent).

## Step 0 — Plan Mode Check

If the system context contains "Plan mode is active":
1. Announce: "This skill requires write operations (gh pr create/edit). Exit plan mode first, then re-invoke `/pr-sdlc`."
2. Stop.

---

## PR Template

> **Custom template:** If `PR_CONTEXT_JSON.customTemplate` is non-null (or `.sdlc/pr-template.md` exists on disk), use its `## Heading` sections instead of the default 8-section structure below. See [label-inference-guide.md](./resources/label-inference-guide.md) for custom-template parsing and version-skew rules.

When no custom template is active, every PR uses this 8-section flat structure. **All sections in the active template are always present.**

```markdown
## Summary
[1-3 sentence plain-language overview accessible to anyone — no jargon]

## Issue Ticket
[Auto-detected from branch name or commit messages, e.g. PROJ-123 or #123.
"Not detected" if no ticket reference found.]

## Business Context
[Why this change is needed from a business/product perspective.
What problem or opportunity prompted it.
"N/A" only for pure internal tooling/infra with no business dimension.]

## Business Benefits
[What value this delivers — user impact, revenue, efficiency,
risk reduction, compliance, etc.
"N/A" only for pure internal tooling/infra with no business dimension.]

## Technical Design
[Architectural approach, key decisions, patterns used.
Non-obvious trade-offs or alternatives considered.]

## Technical Impact
[What systems, services, APIs, or areas are affected.
Breaking changes, migration needs, performance implications.
"N/A" if the change is fully isolated with no external impact.]

## Changes Overview
[Bullet-point list grouped by logical concern (not by file).
Each bullet describes a concept or behavior change — e.g.:
- Webhook handler validates event ID before processing and records it after success
- New migration adds processed_events table with TTL index
- Retry deduplication test coverage added]

## Testing
[How this was verified: manual steps, automated tests, edge cases.
If no tests added, explain why.]
```

**Section fill rules:**
- Include ALL sections in the active template — never omit one
- Fill with real content from commits, diff, or user answers; use **"N/A"** (with brief reason) when inapplicable, or **"Not detected"** when detection yields nothing
- **Never fabricate** — ask a clarifying question (especially for Business Context/Benefits) via `ask_question` if git data is insufficient

---

## Workflow

### Step 0: Resolve and Run skill/pr.js

> **VERBATIM** — Execute directly with `node` and the absolute plugin path (`<PLUGIN_ROOT>/scripts/<skill|util|lib>/<script-name>.js`). Do not modify, rephrase, or simplify the flags.

```shell
PR_CONTEXT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/pr.js" $ARGUMENTS)
EXIT_CODE=$?
```
> **Contract:** Forwards `$ARGUMENTS` verbatim; prints the temp JSON file path to stdout (`PR_CONTEXT_FILE`) with exit code `EXIT_CODE`.

Read (`read_file`) and parse `PR_CONTEXT_FILE` as `PR_CONTEXT_JSON`. Run `rm -f "$PR_CONTEXT_FILE"` on every terminal branch (success, cancel, error).

- **Exit code 1:** JSON contains `errors[]`. Display each error and stop.
- **Exit code 2:** Show `Script error — see output above`, invoke `error-report-sdlc` (search via `find_by_name` or read `**/error-report-sdlc/REFERENCE.md`; `skill=pr-sdlc`, `step=Step 0 — skill/pr.js execution`, `error=stderr`), and stop.
- **`PR_CONTEXT_JSON.errors` non-empty:** Display each error and stop (`pr.js` populates `errors[]` for auth failures, `accountMismatch`, and `tokenExpired`).

**Step 0.5 (BRANCH-GUARD): HARD GATE.** If `PR_CONTEXT_JSON.branchGuard.active === true` and `.ok === false`: surface `branchGuard.message` verbatim and halt immediately — do not run `gh pr create`/`gh pr edit` or re-derive the branch via shell commands.

If `PR_CONTEXT_JSON.warnings` is non-empty, display warnings prominently before continuing (Step 5 `ask_question` is the consent gate). If `PR_CONTEXT_JSON.ghAuth` is non-null, print:

```text
GitHub account switched: now using "<account>" (was "<previousAccount>")
```

### Step 1: Consume the Context

Self-explanatory fields in `PR_CONTEXT_JSON`: `mode`, `baseBranch`, `currentBranch`, `isDraft`, `ghAuth`, `existingPr`, `issueTicket`, `commits`, `diffStat`, `diffContent`, `remoteState`, `warnings`, `changedFiles`, `repoLabels`, `isAuto`. Non-obvious fields:

| Field | Description |
| ----- | ----------- |
| `customTemplate` | Content of `.sdlc/pr-template.md`, or `null` if absent |
| `prConfig` | PR title/label config from `.sdlc/config.json` (`null` when absent) |
| `forcedLabels` | `string[]` — labels from `--label` flags (pre-validated; always included) |
| `existingPr.labels` | `string[]` — labels already on the PR (update mode only; `existingPr` is `null` in create mode) |
| `diffStat.totalLinesChanged` | `number` — total lines added + removed |

### Step 2 (PLAN): Draft PR Description

If `PR_CONTEXT_JSON.customTemplate` is non-null, draft its `## Heading` sections instead of the default 8 sections.

**OpenSpec enrichment (automatic when detected):**
1. Search via `find_by_name` for `openspec/config.yaml`. If absent, skip.
2. Search for `openspec/changes/*/proposal.md` (excluding `archive/`). Use the single match, or disambiguate against `PR_CONTEXT_JSON.currentBranch`. If still ambiguous, skip silently.
3. Read `proposal.md` and `design.md` (if present) via `read_file` in parallel to pre-fill **Business Context/Benefits** and **Technical Design**, reducing `ask_question` prompts.
4. Add below the PR title: `**OpenSpec:** openspec/changes/<name>/`

**Per-section fill rules:**
- **Summary:** Plain-language, no jargon, 1–3 sentences
- **Issue Ticket:** `context.issueTicket` or `"Not detected"`
- **Business Context / Benefits:** Infer from `commits` and `diffContent` (or OpenSpec). If insufficient, use `ask_question` (*"What business problem does this PR solve? Who benefits and how?"*) — don't guess
- **Technical Design / Impact:** Infer architecture, patterns, key decisions, and affected systems/APIs/migrations from `diffContent`
- **Changes Overview:** Group bullets by logical concern/behavior change — never list file paths
- **Testing:** Summarize test coverage from diff; if none, state why

**PR title:** Under 72 characters. When `prConfig` is set, `allowedTypes` and `allowedScopes` take precedence over commit-subject inference; otherwise use conventional commit style (`feat:`, `fix:`, `refactor:`, etc.). See [label-inference-guide.md](./resources/label-inference-guide.md) for common `titlePattern` examples.

#### Step 2b: Infer Labels

Label assignment dispatches on `PR_CONTEXT_JSON.prConfig?.labels?.mode` (defaults to `"off"` when absent; skipped when `repoLabels` is empty):
- `"off"` — no automatic label suggestions (`inferredLabels = []`)
- `"rules"` — consume `PR_CONTEXT_JSON.suggestedLabels` (`source: "rule"`), pre-evaluated by `pr.js`
- `"llm"` — opt-in fuzzy-match against `repoLabels` (`source: "llm"`)

Always drop entries already in `existingPr.labels` (update mode), verify every label exists in `repoLabels[].name`, and prepend `PR_CONTEXT_JSON.forcedLabels` with `source = "forced"` (forced labels apply in all modes, including `"off"`, and win on deduplication). When `isAuto` is true, apply `suggestedLabels` without prompting. See [label-inference-guide.md](./resources/label-inference-guide.md) for mode tables, signal rules, and post-processing details.

### Step 3 (CRITIQUE): Self-review the Draft

Check the draft against every quality gate and note any failures:

| Gate | Check | Pass Criteria |
| ---- | ----- | ------------- |
| All sections present | All `##` sections from active template (custom or default 8) have content | Real content, `"N/A"`, or `"Not detected"` — never empty |
| Specificity | Summary names a concrete change | No vague summaries like "various improvements" |
| Business honesty | Business Context/Benefits are concrete or `"N/A"` | No `"because it was needed"` or invented reasons |
| No file paths | Per Changes Overview rule (applies to custom templates only if they define `Changes Overview`) | Zero file paths in Changes Overview |
| Title length | Title under 72 characters | `len(title) < 72` |
| Title pattern match | Matches `prConfig.titlePattern` regex (skip when null/absent) | Regex passes or `prConfig` is null |
| No fabrication | All claims traceable to commits, diff, or user input | Nothing invented |
| Issue accuracy | Issue matches evidence or is `"Not detected"` | No guessed ticket numbers |
| Audience check | Readable by non-technical stakeholders | No unexplained jargon in Summary/Business sections |
| Documentation sync | Structural/command/script changes have a `docs:` commit on branch or user confirms docs updated | No silent undocumented structural changes |
| Label validity | Every label in `suggestedLabels` exists in `repoLabels` | Zero fabricated labels |
| Forced label inclusion | Every label in `forcedLabels` appears in final `suggestedLabels` | Zero forced labels dropped |
| Link verification | Every URL validated by `scripts/skill/pr.js --validate-body` before publish | `LINK_EXIT === 0`; abort on non-zero |

### Step 4 (IMPROVE): Revise Based on Critique

Fix every failing gate from Step 3 (rewrite vague sections, replace invented claims with `"N/A"`/`"Not detected"`, use `ask_question` for missing business context), then re-check all gates (max 2 iterations per gate).

### Step 5 (DO): Present for Review

Display the title, labels (if non-empty), and full description. **Do not execute any `gh` command before explicit `ask_question` approval** — unless `PR_CONTEXT_JSON.isAuto` is true (still display everything, skip the prompt, and treat as implicit `yes`).

```text
PR Title: <title>
Labels: <label1> (forced), <label2> (rule), <label3> (llm)      [create mode only]
Existing labels (preserved): <existing1>, <existing2>            [update mode only]
New labels: <new1>, <new2>                                       [update mode only]

PR Description:
─────────────────────────────────────────────
<full description>
─────────────────────────────────────────────
```

- **Create mode:** show `Labels:` only when `suggestedLabels` is non-empty, with provenance `(forced)`, `(rule)`, or `(llm)`. Omit when empty.
- **Update mode:** show `Existing labels (preserved):` and `New labels:` only when non-empty. Never print `"Labels: none"`.

Prompt with `ask_question`:
- Create mode: *"Create this PR as shown?"* — **yes** (create PR) | **edit** (specify changes) | **cancel** (abort)
- Update mode: *"Update PR #<number> as shown?"* — **yes** (update PR) | **edit** (specify changes) | **cancel** (abort)

On `edit`, revise and re-present (validate any user-added labels against `repoLabels`). Loop until `yes` or `cancel`.

### Step 6: Create or Update PR

**Execute only after explicit `yes` from Step 5 (or `isAuto`).**

**1. Title pattern validation** (when `prConfig?.titlePattern` is set):

```shell
node "<PLUGIN_ROOT>/scripts/util/validate-pr-title.js" "$title" "$titlePattern" "$titlePatternError"
```

On non-zero exit, show `titlePatternError` (or the pattern as fallback), do NOT publish, and ask the user to edit the title.

**2. Link verification — HARD GATE:** Validate every URL in `$body` via `scripts/skill/pr.js --validate-body` (reads stdin, derives repo identity deterministically — do not construct ctx JSON):

> **VERBATIM** — Execute directly with `node` and the absolute plugin path. Do not modify or simplify the flags.

```shell
printf '%s' "$body" | node "<PLUGIN_ROOT>/scripts/skill/pr.js" --validate-body
LINK_EXIT=$?
```

On `LINK_EXIT != 0`: surface the stderr violation list verbatim and stop immediately — do NOT run `gh pr create`/`gh pr edit`, retry, edit URLs unprompted, or bypass. (`SDLC_LINKS_OFFLINE=1` skips network checks while keeping structural GitHub/Atlassian checks.)

**3. Just-in-time label creation:** For each label in `forcedLabels` missing from `repoLabels`, create it idempotently:

```bash
gh label create "<name>" --description "Auto-created by pr-sdlc" --color "c5def5" 2>/dev/null
```

**4. Publish PR:**
- **Create mode:** Run through `create-pr.js` (single publish path — forwards args to `gh pr create` and runs post-failure account-switch recovery once; omit `--label` if no labels):

```shell
RECOVER_JSON=$(node "<PLUGIN_ROOT>/scripts/util/create-pr.js" --title "<title>" --body "<body>" [--draft] [--label "<l1>" --label "<l2>"])
```

  If `gh` succeeded (exit 0), nothing is printed. On non-zero exit, parse `RECOVER_JSON`:
  - `recovered: true` and `switched: true` → print `Switched gh account to <account> due to repo-permission mismatch — retrying` and re-run `gh pr create` with the same args **once**.
  - `recovered: false` with `hint` → show original stderr + `hint` and fall through to failure fallback.
  - `recovered: false` with `reason: "non-permission-error"` → fall through to failure fallback.

- **Update mode** (omit `--add-label` if no new labels; additive only):

```bash
gh pr edit --title "<title>" --body "<body>" [--add-label "<l1>,<l2>"]
```

Display `Pull request created: <url>` or `Pull request updated: <url>` on success.

**On `gh` failure (after any retry) or unavailability:**

```text
The GitHub CLI (gh) could not complete the operation. You can:
  1. Install gh: https://cli.github.com/
  2. Authenticate: gh auth login
  3. If multiple accounts are configured, switch to the correct one: gh auth switch
  4. Create or update the PR manually — here is your generated description to copy:

Title: <title>

<description>
```

**On script crash (exit 2):** Invoke `error-report-sdlc` (`**/error-report-sdlc/REFERENCE.md`) with `skill=pr-sdlc`, `step=Step 6 — Create or Update PR`, `error=gh CLI failure message`.

---

## Best Practices

1. **Read ALL commits, not just the latest** — the PR represents all branch work
2. **Diff is ground truth** — trust the diff when commit messages disagree
3. **Ask rather than guess** — clarify via `ask_question` instead of fabricating
4. **Flag risks** — call out migrations, permission changes, or config changes
5. **Preserve author intent** — carry design rationale from commits into the description

## DO NOT

- Omit any section from the active template (default 8 or custom) — always include all defined sections
- Write generic descriptions ("various improvements", "code cleanup")
- Fabricate a JIRA ticket, business reason, or technical claim
- Execute `gh pr create` or `gh pr edit` without explicit user approval (unless `--auto` was passed)
- Skip the plan-critique-improve-do-critique-improve cycle before presenting to the user
- Run git or gh `run_command` calls to gather data — all context comes from `PR_CONTEXT_JSON`

## Error Recovery

> **Flow:** detect → diagnose → auto-recover (retry once if transient) → invoke `error-report-sdlc` for persistent actionable failures.

| Error | Recovery | Invoke error-report-sdlc? |
| ----- | -------- | ------------------------- |
| `skill/pr.js` exit 1 (`errors[]` present) | Show each error, stop | No — user input/auth error |
| `skill/pr.js` exit 2 (crash) | Show stderr, stop | Yes (`Step 0`) |
| `gh pr create` permission error | Auto-recover once via `create-pr.js`; otherwise surface stderr + login hint | No on first retry; Yes if retry fails |
| `gh pr create` / `gh pr edit` 5xx or unexpected failure | Show error + manual copy fallback | Yes (`Step 6`) |
| `gh` unavailable or auth failure | Show install / `gh auth login` instructions | No — user setup/auth |

When invoking `error-report-sdlc`, set **Skill:** `pr-sdlc`, **Step:** `Step 0` or `Step 6`, **Operation:** `skill/pr.js` or `gh pr create`/`gh pr edit`, **Error:** exit 2 + stderr or `gh` output, **Suggested investigation:** check plugin version, git remote, and pushed branch.

---

## Gotchas

- **Large diff output:** `diffContent` can exceed 100 KB and truncate if piped through a shell parser (`Unterminated string in JSON`). Always read `PR_CONTEXT_FILE` from disk via `read_file` — never re-pipe `skill/pr.js` output.
- **Installed plugin version skew:** Older installed plugins may return `customTemplate: null` even when `.sdlc/pr-template.md` exists on disk. Cross-check `.sdlc/pr-template.md` before falling back (see [label-inference-guide.md](./resources/label-inference-guide.md)).
- **Multiple GitHub accounts:** Pre-flight (`ensureGhAccount`) and `create-pr.js` handle most mismatches automatically; collaborator repos with no matching local login still require manual `gh auth switch --user <login>`.
- **Non-blocking OpenSpec enrichment:** If multiple active changes exist and cannot be matched to `currentBranch`, skip OpenSpec enrichment silently — never block PR creation.

## Learning Capture

Append PR workflow discoveries to `.sdlc/learnings/log.md` (repo PR conventions, branch naming patterns, CI description rules, template preferences, JIRA key patterns, or review quirks).

## What's Next

- `/review-sdlc` — review the branch
- `/version-sdlc` — tag a release after merge
- If OpenSpec enrichment applied: `/opsx:verify` (after merge) and `/opsx:archive` (after verification)

## See Also

- [`/commit-sdlc`](../commit-sdlc/SKILL.md) — commit changes before creating a PR
- [`/review-sdlc`](../review-sdlc/SKILL.md) — review the branch
- [`/setup-sdlc --pr-template`](../setup-sdlc/SKILL.md) — create a custom PR template
- [`/version-sdlc`](../version-sdlc/SKILL.md) — tag a release after merge
