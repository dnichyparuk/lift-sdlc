---
name: pr-sdlc
description: "Use this skill when creating or updating a pull request, updating a PR description, or generating PR content from commits and diffs. Handles the full PR workflow: consumes pre-computed context from skill/pr.js, generates description with plan-critique-improve-do-critique-improve, user review, and gh CLI execution. Auto-labels PRs based on context signals (branch, commits, diff, Jira) with mandatory approval. Arguments: [--draft] [--update] [--base <branch>] [--auto] [--label <name>]. Use --auto to skip interactive approval. Triggers on: create PR, open pull request, update PR, write PR description, PR summary, describe changes for a pull request."
user-invocable: true
argument-hint: "[--draft] [--update] [--base <branch>] [--auto] [--label <name>]"
model: gemini-3.5-flash
---

# Creating Pull Requests

Consume pre-computed git context from `skill/pr.js` and generate an 8-section
PR description readable by both technical and non-technical stakeholders.

**Announce at start:** "I'm using pr-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

## Step 0 — Plan Mode Check

If the system context contains "Plan mode is active":

1. Announce: "This skill requires write operations (gh pr create/edit). Exit plan mode first, then re-invoke `/pr-sdlc`."
2. Stop. Do not proceed to subsequent steps.

---

## When to Use This Skill

- Creating a new pull request on any branch
- Updating an existing PR title or description
- Writing or rewriting a PR description
- Summarizing branch changes for review
- When the `/pr` command delegates here after running `skill/pr.js`

## PR Template

> **Custom template**: If `PR_CONTEXT_JSON.customTemplate` is not null, use it as the
> template instead of the default 8-section structure below. Parse every `## Heading`
> line as a section name; the text under each heading is the fill instruction for that
> section. Apply the same fill rules: real content, "N/A", or "Not detected" — never
> fabricate. All sections defined in the custom template must appear in the output.

When no custom template is present, every PR uses this 8-section flat structure. **All sections in the active template are always present.**

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
- Retry deduplication test coverage added
No file paths in this section.]

## Testing
[How this was verified: manual steps, automated tests, edge cases.
If no tests added, explain why.]
```

**Section fill rules:**

- ALL sections in the active template MUST always be present — never omit one (8 sections for the default; the custom template's sections when a custom template is active)
- Fill with real content when derivable from commits, diff, or user answers
- Use **"N/A"** when a section genuinely doesn't apply (state why briefly)
- Use **"Not detected"** when detection was attempted but yielded nothing
- **Never fabricate** — if unsure, ask a clarifying question before filling
- Ask clarifying questions (especially for Business Context and Business Benefits)
  when git data alone isn't sufficient to fill the section confidently

---

## Workflow

### Step 0: Resolve and Run skill/pr.js

> **VERBATIM** — Run this bash block exactly as written. Do not modify, rephrase, or simplify the commands.

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

SCRIPT="$SDLC_ROOT/scripts/skill/pr.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/pr.js. Is the sdlc plugin installed?" >&2; exit 2; }

PR_CONTEXT_FILE=$(node "$SCRIPT" --output-file $ARGUMENTS)
EXIT_CODE=$?
# Single canonical cleanup: trap fires unconditionally on EXIT/INT/TERM, so
# the manifest is removed even if a PR creation/update path errors out.
trap 'rm -f "$PR_CONTEXT_FILE"' EXIT INT TERM

```

Read and parse `PR_CONTEXT_FILE` as `PR_CONTEXT_JSON`. The `trap` above guarantees cleanup on any exit path — do not add scattered `rm -f` calls in success/cancel branches.

**On non-zero `EXIT_CODE`:**

- Exit code 1: The JSON still contains an `errors` array. Show each error to the user and stop.
- Exit code 2: Show `Script error — see output above` and stop.

**On script crash (exit 2):** Invoke error-report-sdlc — Glob `**/error-report-sdlc/REFERENCE.md`, follow with skill=pr-sdlc, step=Step 0 — skill/pr.js execution, error=stderr.

**If `PR_CONTEXT_JSON.errors` is non-empty**, show each error message and stop.

**Note (issue #234):** The prepare script (`skill/pr.js`) populates `errors[]` for auth failures, account mismatches (`accountMismatch`), and expired tokens (`tokenExpired`). The `errors[]` check above already halts on all of these — the reactive recovery flow later in this skill handles edge cases the preflight cannot anticipate (e.g., permission revocation between preflight and `gh pr create`).

**Step 0.5 (BRANCH-GUARD): HARD GATE — Expected Branch Check**

**Implements R-expected-branch (docs/specs/pr-sdlc.md, issues #347, #348, #349).**

Check `branchGuard.active` and `branchGuard.ok` from `PR_CONTEXT_JSON`.

If `branchGuard.active === true` AND `branchGuard.ok === false`:
- Surface `branchGuard.message` verbatim to the user.
- Halt the skill immediately. Do NOT proceed to Step 1 or any `gh pr create` / `gh pr edit` invocation.
- Do NOT re-derive the current branch via shell commands — use the resolved `branchGuard` field only.

If `branchGuard.active === false` (flag was not passed) or `branchGuard.ok === true` (branches match): proceed.

**If `PR_CONTEXT_JSON.warnings` is non-empty**, show the warnings prominently before continuing.
Do not ask for confirmation — the Step 5 approval gate (AskUserQuestion) is the consent point before PR creation.

**If `PR_CONTEXT_JSON.ghAuth` is not null**, inform the user before continuing (no confirmation needed):

```text
GitHub account switched: now using "<account>" (was "<previousAccount>")
```

### Step 1: Consume the Context

Read `PR_CONTEXT_JSON` now.

Key fields available (including `customTemplate` added for project-level PR template support):

| Field | Description |
| ----- | ----------- |
| `mode` | `"create"` or `"update"` |
| `baseBranch` | The target base branch |
| `currentBranch` | The branch being PR'd |
| `isDraft` | Whether to create a draft PR |
| `ghAuth` | `{ switched, account, previousAccount }` or `null` — GitHub account switch result |
| `existingPr` | `{ number, title, url, state, labels }` or `null` |
| `issueTicket` | Detected ticket reference or `null` |
| `commits` | `[{ hash, subject, body, coAuthors }]` — all commits on this branch |
| `diffStat` | `{ filesChanged, insertions, deletions, totalLinesChanged, summary }` |
| `diffContent` | Full unified diff text |
| `remoteState` | `{ pushed, remoteBranch, action }` |
| `warnings` | Non-fatal notes already surfaced to the user by the command |
| `changedFiles` | `string[]` — relative file paths changed in this PR |
| `repoLabels` | `[{ name, description }]` — labels defined in the repository; empty if unavailable |
| `customTemplate` | Full content of `.sdlc/pr-template.md` (canonical) or `.claude/pr-template.md` (deprecated fallback, one-time stderr warning per process); `null` if neither file exists. Issue #260. |
| `prConfig` | PR title validation config from `.sdlc/config.json` (null when absent) |
| `isAuto` | Whether `--auto` was passed — skip interactive prompts |
| `forcedLabels` | `string[]` — labels forced via `--label` flag(s), pre-validated against `repoLabels`. Always included in PR regardless of signal matching |

### Step 2 (PLAN): Draft PR Description

> **If `PR_CONTEXT_JSON.customTemplate` is not null**: parse its `## Section` headings
> as the template structure. Use each section's body text as the fill instruction.
> Skip the default per-section instructions below and draft all custom sections instead.

Using data from `PR_CONTEXT_JSON`, draft all sections of the active PR template (custom sections if `customTemplate` is present, or the default 8 sections below).

**OpenSpec enrichment (automatic when detected):**

**Hook context fast-path:** If the session-start system-reminder contains an `OpenSpec active:` line, use its data (change name, branch match status, delta spec count) to skip the `Glob for openspec/config.yaml` and change directory scanning. If the line is absent or the user switched branches since session start, fall back to the existing Glob-based detection. The hook context is a session-start snapshot — treat it as a hint, not as authoritative.

1. Glob for `openspec/config.yaml`. If absent, skip this block entirely.
2. Identify the active change: Glob `openspec/changes/*/proposal.md` (exclude `archive/`). If one matches, use it. If multiple, match against `PR_CONTEXT_JSON.currentBranch`. If ambiguous, skip — do not ask during PR creation.
3. If an active change is found, Read in parallel:
   - `proposal.md` — use intent and scope to pre-fill **Business Context** and **Business Benefits** (reduces need for AskUserQuestion clarification)
   - `design.md` (if exists) — use architectural approach for **Technical Design** section
4. Add to the PR description, below the title: `**OpenSpec:** openspec/changes/<name>/`

When OpenSpec context provides business rationale, use it directly instead of asking the user. Still ask if the proposal is too vague to fill Business Context/Benefits confidently.

For each section, apply the fill rules:

- **Summary**: Plain-language, no jargon, 1-3 sentences
- **Issue Ticket**: Use `context.issueTicket` or "Not detected"
- **Business Context / Benefits**: Infer from `context.commits` and `context.diffContent`. If insufficient evidence, **use AskUserQuestion** to ask the user before writing. Don't guess. Acceptable question: *"What business problem does this PR solve? Who benefits and how?"*
- **Technical Design**: Infer from `context.diffContent` — architecture, patterns, key decisions
- **Technical Impact**: Identify affected systems/APIs/services from the diff
- **Changes Overview**: Group by logical concern — each bullet describes a concept or behavior change (e.g. "Added retry deduplication", "New database migration for event tracking"). Never list file paths. Think about what a reviewer needs to understand, not which files were touched.
- **Testing**: Summarize test coverage from diff; if none, say so explicitly

Also draft the PR title: under 72 characters. If `prConfig` is non-null, constrain the title generation:
- **allowedTypes** set → choose from allowed types only for the title prefix (e.g., if `allowedTypes: ["feat", "fix"]`, only use those)
- **allowedScopes** set → choose from allowed scopes only (e.g., if `allowedScopes: ["api", "ui"]`, only use those)
- Config constraints take precedence over conventional commit style inference from commit subjects

If `prConfig` is null or absent, use conventional commit style (`feat:`, `fix:`, `refactor:`, etc.).

#### Common Patterns Reference

Teams can configure their PR title patterns in `.sdlc/config.json`. Here are four real-world examples to guide configuration:

**Pattern 1: Conventional Commits**
```json
{
  "pr": {
    "titlePattern": "^(feat|fix|refactor|chore|docs|test|ci)(\\([a-z-]+\\))?: .+$",
    "titlePatternError": "Title must follow conventional commits: type(scope): description",
    "allowedTypes": ["feat", "fix", "refactor", "chore", "docs", "test", "ci"],
    "allowedScopes": []
  }
}
```

**Pattern 2: Ticket Prefix**
```json
{
  "pr": {
    "titlePattern": "^[A-Z]{2,10}-\\d+: .+$",
    "titlePatternError": "Title must start with ticket ID (e.g., PROJ-42: description)",
    "allowedTypes": [],
    "allowedScopes": []
  }
}
```

**Pattern 3: Ticket Prefix + Conventional**
```json
{
  "pr": {
    "titlePattern": "^[A-Z]{2,10}-\\d+ (feat|fix|chore): .+$",
    "titlePatternError": "Title format: TICKET-123 type: description",
    "allowedTypes": ["feat", "fix", "chore"],
    "allowedScopes": []
  }
}
```

**Pattern 4: Semantic PR (Squash-Merge Friendly)**
```json
{
  "pr": {
    "titlePattern": "^(feat|fix|breaking): .+$",
    "titlePatternError": "Title must use semantic type: feat|fix|breaking",
    "allowedTypes": ["feat", "fix", "breaking"],
    "allowedScopes": []
  }
}
```

#### Step 2b: Infer Labels

Label assignment is **mode-dispatched** based on `PR_CONTEXT_JSON.prConfig?.labels?.mode` (issue #197). Each suggested label carries a provenance tag — `(forced)`, `(rule)`, or `(llm)` — used in the Step 5 display.

**Mode resolution:**

- If `PR_CONTEXT_JSON.repoLabels` is empty, skip evaluation entirely and treat the result as `suggestedLabels = []`. Forced labels still apply (see "Forced labels" below).
- Otherwise read `mode = PR_CONTEXT_JSON.prConfig?.labels?.mode`. When absent, default to `"off"`. Dispatch:
  - `"off"` → see [Off mode](#off-mode)
  - `"rules"` → see [Rules mode](#rules-mode)
  - `"llm"` → see [LLM mode](#llm-mode)

The mode dispatch produces an array of `{ label, source }` entries (where `source ∈ {"rule", "llm"}`). Forced labels are merged on top with `source = "forced"`.

##### Off mode

Set `inferredLabels = []`. No automatic suggestions are produced. The merged `suggestedLabels` array contains only forced labels (or is empty when none are forced).

##### Rules mode

Iterate `PR_CONTEXT_JSON.prConfig.labels.rules` (already validated against `repoLabels` by `pr.js` — unknown labels were stripped before this step). For each rule, evaluate the single signal in `rule.when` against the PR context:

| Signal | Match condition |
| ------ | --------------- |
| `branchPrefix: string[]` | `currentBranch` starts with any listed prefix |
| `commitType: string[]` | Any commit subject begins with `<type>:` or `<type>(scope):` (Conventional Commits) |
| `pathGlob: string[]` | **Every** entry in `changedFiles` matches at least one glob (all-changed-files semantics, like the legacy `*.md → documentation` rule) |
| `jiraType: string[]` | `jiraTicket.type` (when extracted) is in the list |
| `diffSizeUnder: number` | `diffStat.totalLinesChanged < value` |

Collect every matched `rule.label` and dedupe (multiple rules may target the same label — they OR together). Tag each survivor with `source = "rule"`.

##### LLM mode

Run the legacy fuzzy-match heuristic. This branch is **opt-in only** — the user must have explicitly selected `mode = "llm"` during `setup-sdlc --only pr-labels`.

**Signals to match:**

| Signal | Example match |
| ------ | ------------- |
| Branch prefix (`fix/`, `feat/`, `docs/`, `refactor/`, `chore/`) | `bug`/`bugfix`, `enhancement`/`feature`, `documentation`, `refactoring` |
| Commit subject prefixes (conventional commits) | Same as branch prefix |
| Changed file paths (`changedFiles`) | Only `.md` files → `documentation`; only test files → `tests`; CI config files → `ci`/`infrastructure` |
| Diff size (`diffStat`) | Small diff (<50 lines changed) → `small`/`quick-review` |
| Jira ticket type (if available) | Bug ticket → `bug`; Story → `feature`/`enhancement` |

**Matching rules:**

1. Fuzzy-match each signal against `repoLabels[].name` and `repoLabels[].description` — e.g., repo has `type:bug` and branch is `fix/...` → match
2. Never suggest a label not in `repoLabels` — only exact names from the list are valid
3. Keep suggestions conservative: 1–4 labels typical; deduplicate (multiple signals matching the same label count as one)

Tag each survivor with `source = "llm"`.

##### Common post-processing

Regardless of branch:

1. **Update mode:** when `existingPr.labels` is non-empty, drop any inferred entry already present there — they are already applied.
2. **Validity gate (defense-in-depth):** every entry must appear in `repoLabels[].name`. Drop fabricated entries (Step 3's "Label validity" gate is the contract; this drop ensures `rules` mode stays exact and catches `llm` hallucinations).
3. **Forced labels:** if `PR_CONTEXT_JSON.forcedLabels` is non-empty, prepend each forced label with `source = "forced"`. Forced labels are always included regardless of mode (including `off`) — they cannot be removed during interactive edit. Deduplicate by label name; if the same name was inferred and forced, keep only the forced entry (forced wins for provenance).
4. **Output:** `suggestedLabels` — the final ordered, deduped list of `{ label, source }` entries. Forced first, then rule/llm matches in iteration order. If empty, no Labels line is shown in Step 5.

**Auto mode:** When `PR_CONTEXT_JSON.isAuto` is true, apply `suggestedLabels` directly without presenting them for approval. Labels are still validated against `repoLabels` — no fabricated labels. The applied labels are shown in the Step 5 output for visibility.

**Forced labels behavior summary:** The CLI `--label <name>` flag and ship-sdlc's `skip-version-check` injection bypass `pr.labels.mode` entirely. Forced labels apply in all three modes (`off`, `rules`, `llm`).

### Step 3 (CRITIQUE): Self-review the Draft

Before presenting to the user, review the draft against every quality gate:

| Gate | Check | Pass Criteria |
| ---- | ----- | ------------- |
| All sections present | If custom template: all `##` sections from `customTemplate` have content. If default: all 8 hardcoded sections exist | Real content, "N/A", or "Not detected" — never empty |
| Specificity | Summary names a concrete change | No vague summaries like "various improvements" |
| Business honesty | Business Context/Benefits are concrete or "N/A" | No "because it was needed" or invented reasons |
| No file paths | Changes Overview uses concepts only | Zero file paths in this section |
| Title length | Title under 72 characters | `len(title) < 72` |
| Title pattern match | Title matches `prConfig.titlePattern` regex (skip when null/absent) | Regex passes or `prConfig` is null |
| No fabrication | All claims traceable to commits, diff, or user input | Nothing invented |
| Issue accuracy | Issue value matches evidence or is "Not detected" | No guessed ticket numbers |
| Audience check | Readable by non-technical stakeholders | No unexplained jargon in Summary/Business sections |
| Documentation sync | If diff adds new commands, changes structure, renames concepts, or adds new directories/scripts: check that at least one `docs:` commit exists on this branch OR ask the user to confirm docs are updated | PR does not silently ship structural changes without a corresponding docs update |
| Label validity | Every label in `suggestedLabels` exists in `repoLabels` | Zero fabricated labels |
| Forced label inclusion | Every label in `forcedLabels` appears in the final `suggestedLabels` list | Zero forced labels dropped |
| Link verification (R15, #198) | Every URL in the body is validated by `scripts/skill/pr.js --validate-body` before `gh pr create` / `gh pr edit`. The script enforces — SKILL.md only invokes it. See the Link verification block in the publish step. | `LINK_EXIT === 0`; on non-zero, abort and surface violations |

> **Note**: When a custom template is active, the "No file paths in Changes Overview"
> gate applies only if the custom template includes a section named "Changes Overview".
> All other universal gates (title length, no fabrication, JIRA accuracy, audience
> check, documentation sync) apply regardless of template.

Note every failing gate.

### Step 4 (IMPROVE): Revise Based on Critique

Fix each issue found in Step 3:

- Rewrite vague sections with specifics from the diff
- Replace invented content with "N/A" or "Not detected" plus a note
- If a business section still can't be filled confidently after revision,
  **use AskUserQuestion** to ask a targeted clarifying question and incorporate the answer
- Re-check all quality gates after revisions

Continue until all gates pass (max 2 iterations per gate).

### Step 5 (DO): Present for Review

Show the complete title, labels (if any), and description. **Do not execute any `gh` command
before receiving explicit user approval via AskUserQuestion.**

**Auto mode:** When `PR_CONTEXT_JSON.isAuto` is true, skip the AskUserQuestion prompt entirely. Still display the full title, labels, and description for visibility, then proceed directly to Step 6 (execution). Treat the response as an implicit `yes`. All critique gates (Steps 3–4) still run — only the interactive approval prompt is skipped.

**Create mode** (with `suggestedLabels` non-empty):

```text
PR Title: <title>
Labels: <label1> (forced), <label2> (rule), <label3> (llm)

PR Description:
─────────────────────────────────────────────
<full description>
─────────────────────────────────────────────
```

Each label carries its provenance suffix from the Step 2b dispatch:
- `(forced)` — applied via CLI `--label` or ship-sdlc injection (e.g. `skip-version-check`)
- `(rule)` — matched a deterministic rule under `pr.labels.rules` (mode = `rules`)
- `(llm)` — fuzzy-matched by the model (mode = `llm`, opt-in)

When `pr.labels.mode = "off"` and no forced labels are present, omit the Labels line entirely (existing behavior — do not show "Labels: none").

**Update mode** (with existing labels and new suggestions):

```text
PR Title: <title>
Existing labels (preserved): <existing1>, <existing2>
New labels: <new1>, <new2>

PR Description:
─────────────────────────────────────────────
<full description>
─────────────────────────────────────────────
```

If no labels are suggested, omit the Labels line entirely — do not show "Labels: none".
In update mode, if there are existing labels but no new suggestions, still show the "Existing labels (preserved)" line but omit "New labels".

```text
Use AskUserQuestion to ask (adapt question to mode):

For create mode:
> Create this PR as shown?
Options: **yes** — create the PR | **edit** — tell me what to change | **cancel** — abort

For update mode:
> Update PR #<number> as shown?
Options: **yes** — update the PR | **edit** — tell me what to change | **cancel** — abort
```

If the user chooses `edit`, ask what to change, revise, and present again.
During the edit flow, users can add or remove labels. Any added labels must be validated against `repoLabels` — reject labels not in the list.
Loop until explicit `yes` or `cancel`.

### Step 6: Create or Update PR

**Only execute after explicit `yes` from Step 5.**

**Pre-execution title pattern validation:** Before executing `gh pr create` or `gh pr edit`, if `prConfig` is non-null and `prConfig.titlePattern` is set, validate the title against the pattern:

```bash
node -e "
const title = process.argv[1];
const pattern = process.argv[2];
const error = process.argv[3];
if (!new RegExp(pattern).test(title)) {
  console.error(error || pattern);
  process.exit(1);
}
" "$title" "$titlePattern" "$titlePatternError"
```

On failure:
- Show the error message from `prConfig.titlePatternError` (or the pattern itself as fallback)
- Do NOT create or edit the PR
- Ask the user to edit the title and retry

On success:
- Continue to link verification, label creation, and `gh pr create` / `gh pr edit`

**Link verification (issue #198, implements spec R15) — HARD GATE:** Before executing `gh pr create` or `gh pr edit`, validate every URL embedded in the final PR body via `scripts/skill/pr.js --validate-body`. The script reads the body from stdin and derives the expected GitHub repo identity (`parseRemoteOwner(projectRoot)`) deterministically — the skill MUST NOT construct ctx JSON.

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

PR_PREPARE="$SDLC_ROOT/scripts/skill/pr.js"
[ ! -f "$PR_PREPARE" ] && { echo "ERROR: Could not locate scripts/skill/pr.js. Is the sdlc plugin installed?" >&2; exit 2; }
[ -z "$PR_PREPARE" ] && [ -f "plugins/sdlc-utilities/scripts/skill/pr.js" ] && PR_PREPARE="plugins/sdlc-utilities/scripts/skill/pr.js"
printf '%s' "$body" | node "$PR_PREPARE" --validate-body
LINK_EXIT=$?

```

On non-zero exit (`LINK_EXIT != 0`):
- The script has already printed the violation list to stderr (URL, line, reason code, observed/expected detail)
- Do NOT execute `gh pr create` or `gh pr edit`
- Surface the violation list verbatim to the user
- Stop. Do not retry. Do not edit URLs without user input. Do not bypass.

On zero exit, continue to label creation and the publish step.

`SDLC_LINKS_OFFLINE=1` skips network reachability checks but keeps structural context-aware checks (GitHub identity match, Atlassian host match) — use this in sandboxed CI runs.

**Just-in-time label creation:** Before executing `gh pr create` or `gh pr edit`, check each label in `forcedLabels` against `repoLabels`. For any forced label NOT found in `repoLabels`, create it:

```bash
gh label create "<name>" --description "Auto-created by pr-sdlc" --color "c5def5" 2>/dev/null
```

This is idempotent — the command succeeds silently if the label already exists. This ensures forced labels work in any repository where the plugin is installed, not just repos where labels were pre-created.

**Create mode:**

```bash
gh pr create --title "<title>" --body "<body>" [--draft] [--label "<l1>" --label "<l2>"]
```

If no labels were approved, omit the `--label` flags entirely.

**Post-failure account-switch recovery (implements spec E7, issue #184):** If `gh pr create` exits non-zero, capture stderr to a temp file and invoke the recovery helper exactly once:

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

ERR_FILE=$(mktemp)
gh pr create --title "<title>" --body "<body>" [--draft] [--label ...] 2> "$ERR_FILE"
GH_EXIT=$?
if [ "$GH_EXIT" -ne 0 ]; then
RECOVER_SCRIPT="$SDLC_ROOT/scripts/skill/pr-recover-gh-account.js"
[ ! -f "$RECOVER_SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/pr-recover-gh-account.js. Is the sdlc plugin installed?" >&2; exit 2; }
  [ -z "$RECOVER_SCRIPT" ] && [ -f "plugins/sdlc-utilities/scripts/skill/pr-recover-gh-account.js" ] && RECOVER_SCRIPT="plugins/sdlc-utilities/scripts/skill/pr-recover-gh-account.js"
  if [ -n "$RECOVER_SCRIPT" ]; then
    RECOVER_JSON=$(node "$RECOVER_SCRIPT" --error-file "$ERR_FILE")
  else
    echo "Warning: pr-recover-gh-account.js not found — skipping account-switch recovery"
  fi
fi
rm -f "$ERR_FILE"

```

Parse `RECOVER_JSON`. Branches:

- `recovered: true` and `switched: true` — print one user-visible line: `Switched gh account to <account> due to repo-permission mismatch — retrying`. Re-run `gh pr create` with the same arguments **exactly once**. A second consecutive failure is terminal and falls through to the existing failure path below.
- `recovered: false` and `hint` is present — surface the original stderr followed by the hint (e.g., `Run \`gh auth login --hostname <host>\` to authenticate the account that owns this repo.`) and proceed to the existing failure fallback.
- `recovered: false` and `reason: "non-permission-error"` — proceed straight to the existing failure fallback (this is not an account problem).

The retry runs at most once per pipeline invocation. The recovery helper is the single source of decision logic — SKILL.md only orchestrates capture, invocation, and re-run.

**Update mode:**

```bash
gh pr edit --title "<title>" --body "<body>" [--add-label "<l1>,<l2>"]
```

If no new labels were approved, omit the `--add-label` flag entirely. Note: `--add-label` is additive — it never removes existing labels.

After success, display the PR URL:

```text
# Create mode:
Pull request created: <url>

# Update mode:
Pull request updated: <url>
```

**If `gh` is unavailable or fails (after any account-switch retry has already run)**, show the error and provide a fallback:

```text
The GitHub CLI (gh) could not complete the operation. You can:
  1. Install gh: https://cli.github.com/
  2. Authenticate: gh auth login
  3. If multiple accounts are configured, switch to the correct one: gh auth switch
  4. Create or update the PR manually — here is your generated description to copy:

Title: <title>

<description>
```

**On script crash (exit 2):** Invoke error-report-sdlc — Glob `**/error-report-sdlc/REFERENCE.md`, follow with skill=pr-sdlc, step=Step 6 — Create or Update PR, error=gh CLI failure message.

---

## Best Practices

1. **Read ALL commits, not just the latest** — the PR is the sum of all branch work
2. **Diff is ground truth** — when commit messages and diff disagree, trust the diff
3. **Ask rather than guess** — a clarifying question is better than fabricated content
4. **No file paths in Changes Overview** — reviewers think in concepts, not paths
5. **Flag risks** — call out migrations, permission changes, or config changes
6. **Preserve author intent** — if commit messages express design rationale, carry it into the description

## DO NOT

- Omit any section from the active template (default 8 or custom) — always include all defined sections
- Write generic descriptions ("various improvements", "code cleanup")
- Fabricate a JIRA ticket, business reason, or technical claim
- Include file paths in the Changes Overview section (this rule applies only if the active template includes a "Changes Overview" section)
- Execute `gh pr create` or `gh pr edit` without explicit user approval (unless `--auto` was passed)
- Skip the plan-critique-improve-do-critique-improve cycle before presenting to the user
- Run git or gh bash commands to gather data — all context comes from `PR_CONTEXT_JSON`

## Error Recovery

> **Flow**: detect → diagnose → auto-recover (retry once if transient) → invoke `error-report-sdlc` for persistent actionable failures.

| Error | Recovery | Invoke error-report-sdlc? |
|-------|----------|---------------------------|
| `skill/pr.js` exit 1 (`errors[]` present) | Show each error, stop | No — user input error |
| `skill/pr.js` exit 2 (crash) | Show stderr, stop | Yes |
| `gh pr create` fails with `does not have the correct permissions to execute CreatePullRequest` (spec E7) | Auto-recover: invoke `pr-recover-gh-account.js` once; if a matching local gh account exists, switch and retry `gh pr create` exactly once. If no match, surface original error + `gh auth login --hostname <host>` hint and continue with the manual fallback below. | No on first retry; Yes only if the retry also fails |
| `gh pr create` / `gh pr edit` fails with 5xx or unexpected error | Show error; offer manual fallback (copy title + description) | Yes |
| `gh` unavailable | Show install instructions | No — user setup |
| `gh` auth failure | Show `gh auth login` instructions | No — auth, not a bug |

When invoking `error-report-sdlc`, provide:
- **Skill**: pr-sdlc
- **Step**: Step 0 (script crash) or Step 6 (gh CLI failure)
- **Operation**: `skill/pr.js` execution or `gh pr create` / `gh pr edit`
- **Error**: exit code 2 + stderr, or gh error output
- **Suggested investigation**: Check installed plugin version; verify git remote is configured and branch is pushed

---

## Gotchas

- **Large diff output**: `skill/pr.js` embeds full `diffContent` inline in its JSON. For repos
  with many changed files this easily exceeds 100KB — too large to pipe through a shell command
  without truncation (failure manifests as "Unterminated string in JSON at position N"). The
  `pr.md` command already prescribes writing to a temp file (`mktemp`). If you ever need to
  re-run the script manually, always use `node skill/pr.js > /tmp/pr-context-$$.json` and
  read from the file rather than piping output to a parser.

- **Installed plugin version skew silently suppresses custom template**: `skill/pr.js` is
  resolved from the installed plugin, which may be older than the project's local copy. An
  older installed version may lack `customTemplate` support entirely, returning the field as
  absent or `null` even when `.sdlc/pr-template.md` exists on disk. **Always cross-check**:
  if `PR_CONTEXT_JSON.customTemplate` is null or absent, verify whether `.sdlc/pr-template.md` (or its
  deprecated fallback `.claude/pr-template.md`)
  exists before defaulting to the 8-section template. If the file exists, read it directly and
  use it as the template, then warn the user that the installed plugin may be out of date and
  suggest re-installing (`/plugin install sdlc@sdlc-marketplace`).

- **Multiple GitHub accounts — auto-recovery covers most mismatches**: Pre-flight, the skill
  matches the active `gh` account against the remote repo owner (via `ensureGhAccount`).
  Post-flight (spec E7, issue #184), if `gh pr create` still fails with a `CreatePullRequest`
  permission error, the skill invokes `pr-recover-gh-account.js` once: it parses the repo
  owner, looks for a local gh account whose login matches, runs `gh auth switch`, and retries
  `gh pr create` exactly once. The user sees a single concise recovery line, not the raw
  GraphQL error. If no matching account is configured locally, the skill surfaces a
  `gh auth login --hostname <host>` hint and falls through to the manual fallback. Manual
  `gh auth switch --user <login>` before invoking the skill is still valid for collaborator
  scenarios where no local account login matches the owner.

- **OpenSpec change detection during PR creation should not block.** Unlike plan-sdlc which can ask the user to disambiguate multiple active changes, pr-sdlc should silently skip OpenSpec enrichment if the change cannot be uniquely identified from the branch name. PR creation should never be blocked by spec detection ambiguity.

## Learning Capture

When creating pull requests, capture discoveries by appending to `.sdlc/learnings/log.md`.
Record entries for: repository PR conventions not covered by this skill, branch naming
patterns, CI requirements that affect PR descriptions, team-specific template preferences,
JIRA project key patterns, or review process quirks encountered while generating PR content.

## What's Next

After creating or updating the PR, common follow-ups include:
- `/review-sdlc` — review the branch
- `/version-sdlc` — tag a release after merge

If OpenSpec enrichment was applied in Step 2 (an active change was detected), also suggest:
- `/opsx:verify` — validate implementation completeness against the spec (after merge)
- `/opsx:archive` — merge delta specs into main specs (after verification passes)

## See Also

- [`/commit-sdlc`](../commit-sdlc/SKILL.md) — commit changes before creating a PR
- [`/review-sdlc`](../review-sdlc/SKILL.md) — review the branch
- [`/setup-sdlc --pr-template`](../setup-sdlc/SKILL.md) — create a custom PR template
- [`/version-sdlc`](../version-sdlc/SKILL.md) — tag a release after merge
