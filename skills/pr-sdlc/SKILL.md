---
name: pr-sdlc
description: "Use this skill when creating or updating a pull request, updating a PR description, or generating PR content from commits and diffs. Handles the full PR workflow: consumes pre-computed context from skill/pr.js, generates description with plan-critique-improve-do-critique-improve, user review, and gh CLI execution. Auto-labels PRs based on context signals (branch, commits, diff, Jira) with mandatory approval. Arguments: [--draft] [--update] [--base <branch>] [--auto] [--label <name>]. Use --auto to skip interactive approval. Triggers on: create PR, open pull request, update PR, write PR description, PR summary, describe changes for a pull request."
user-invocable: true
argument-hint: "[--draft] [--update] [--base <branch>] [--auto] [--label <name>]"
model: gemini-3.8-flash-medium
---

# Creating Pull Requests

When to use: creating or updating a PR for the current branch; `/pr` delegates here.

Consume pre-computed git context from `skill/pr.js` and generate an 8-section
PR description readable by both technical and non-technical stakeholders.

**Announce at start:** "I'm using pr-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

## Step 0 — Plan Mode Check

If the system context contains "Plan mode is active":

1. Announce: "This skill requires write operations (gh pr create/edit). Exit plan mode first, then re-invoke `/pr-sdlc`."
2. Stop. Do not proceed to subsequent steps.

---

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
- Retry deduplication test coverage added]

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

> **VERBATIM** — Execute this command directly with `node` and the absolute plugin path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin. Note the strict CLI location pattern: `<PLUGIN_ROOT>/scripts/<skill|util|lib>/<script-name>.js`). Do not modify, rephrase, or simplify the flags.

```shell
PR_CONTEXT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/pr.js" $ARGUMENTS)
EXIT_CODE=$?
```
> **Contract (Input/Output):**
> - **Input**: `$ARGUMENTS` (the skill's own arguments), forwarded verbatim.
> - **Output**: Prints the path of a temp file holding the PR context JSON on stdout — capture it into `PR_CONTEXT_FILE`. Its exit code is `EXIT_CODE`.

Read and parse `PR_CONTEXT_FILE` as `PR_CONTEXT_JSON`. Run `rm -f "$PR_CONTEXT_FILE"` on every terminal branch (success, cancel, error) — there is no trap to rely on for cleanup.

**On non-zero `EXIT_CODE`:**

- Exit code 1: The JSON still contains an `errors` array. Show each error to the user and stop.
- Exit code 2: Show `Script error — see output above` and stop.

**On script crash (exit 2):** Invoke error-report-sdlc — Glob `**/error-report-sdlc/REFERENCE.md`, follow with skill=pr-sdlc, step=Step 0 — skill/pr.js execution, error=stderr.

**If `PR_CONTEXT_JSON.errors` is non-empty**, show each error message and stop.

**Note:** The prepare script (`skill/pr.js`) populates `errors[]` for auth failures, account mismatches (`accountMismatch`), and expired tokens (`tokenExpired`). The `errors[]` check above already halts on all of these — the reactive recovery flow later in this skill handles edge cases the preflight cannot anticipate (e.g., permission revocation between preflight and `gh pr create`).

**Step 0.5 (BRANCH-GUARD): HARD GATE.** If `PR_CONTEXT_JSON.branchGuard.active === true` and `.ok === false`: surface `branchGuard.message` verbatim and halt immediately — do not proceed to Step 1 or any `gh pr create`/`gh pr edit`, and do not re-derive the current branch via shell commands (use the resolved field only). Otherwise (`active === false` or `ok === true`) proceed.

**If `PR_CONTEXT_JSON.warnings` is non-empty**, show the warnings prominently before continuing.
Do not ask for confirmation — the Step 5 approval gate (AskUserQuestion) is the consent point before PR creation.

**If `PR_CONTEXT_JSON.ghAuth` is not null**, inform the user before continuing (no confirmation needed):

```text
GitHub account switched: now using "<account>" (was "<previousAccount>")
```

### Step 1: Consume the Context

Read `PR_CONTEXT_JSON` now. Most fields are self-explanatory: `mode`, `baseBranch`, `currentBranch`, `isDraft`, `ghAuth`, `existingPr`, `issueTicket`, `commits`, `diffStat`, `diffContent`, `remoteState`, `warnings`, `changedFiles`, `repoLabels`, `isAuto`. Non-obvious fields:

| Field | Description |
| ----- | ----------- |
| `customTemplate` | Full content of `.sdlc/pr-template.md` (canonical) or `.sdlc/pr-template.md` (deprecated fallback, one-time stderr warning per process); `null` if neither file exists |
| `prConfig` | PR title validation config from `.sdlc/config.json` (null when absent) |
| `forcedLabels` | `string[]` — labels forced via `--label` flag(s), pre-validated against `repoLabels`. Always included in the PR regardless of signal matching |
| `existingPr.labels` | `string[]` — labels currently applied to the existing PR (update mode only; `existingPr` is `null` in create mode) |
| `diffStat.totalLinesChanged` | `number` — total lines added + removed across the diff |

### Step 2 (PLAN): Draft PR Description

> **If `PR_CONTEXT_JSON.customTemplate` is not null**: parse its `## Section` headings
> as the template structure. Use each section's body text as the fill instruction.
> Skip the default per-section instructions below and draft all custom sections instead.

Using data from `PR_CONTEXT_JSON`, draft all sections of the active PR template (custom sections if `customTemplate` is present, or the default 8 sections below).

**OpenSpec enrichment (automatic when detected):**

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

Teams configure PR title rules via `.sdlc/config.json`'s `pr.titlePattern` (regex), `pr.titlePatternError`, `pr.allowedTypes`, and `pr.allowedScopes`. Common patterns:

| Pattern | `titlePattern` | Example title |
| ------- | -------------- | ------------- |
| Conventional Commits | `^(feat\|fix\|refactor\|chore\|docs\|test\|ci)(\([a-z-]+\))?: .+$` | `feat(auth): add SSO` |
| Ticket prefix | `^[A-Z]{2,10}-\d+: .+$` | `PROJ-42: description` |
| Ticket + Conventional | `^[A-Z]{2,10}-\d+ (feat\|fix\|chore): .+$` | `PROJ-42 feat: description` |
| Semantic (squash-merge friendly) | `^(feat\|fix\|breaking): .+$` | `feat: description` |

Each pattern pairs with a matching `allowedTypes` list (and `allowedScopes` where scopes are used) and a human-readable `titlePatternError` shown on validation failure.

#### Step 2b: Infer Labels

Label assignment is **mode-dispatched** based on `PR_CONTEXT_JSON.prConfig?.labels?.mode`. Each suggested label carries a provenance tag — `(forced)`, `(rule)`, or `(llm)` — used in the Step 5 display.

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

`pr.js` already evaluates `prConfig.labels.rules` (already validated against `repoLabels` — unknown labels were stripped before this step) against the PR context via `evaluateRule`/`matchRule` and returns the matches, deduped by label (multiple rules targeting the same label OR together into one entry), in `PR_CONTEXT_JSON.suggestedLabels` as `{ label, source: "rule" }`. Set `inferredLabels = PR_CONTEXT_JSON.suggestedLabels` directly — no signal matching happens here.

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
| No file paths | Per the Step 2 Changes Overview fill rule | Zero file paths in this section |
| Title length | Title under 72 characters | `len(title) < 72` |
| Title pattern match | Title matches `prConfig.titlePattern` regex (skip when null/absent) | Regex passes or `prConfig` is null |
| No fabrication | All claims traceable to commits, diff, or user input | Nothing invented |
| Issue accuracy | Issue value matches evidence or is "Not detected" | No guessed ticket numbers |
| Audience check | Readable by non-technical stakeholders | No unexplained jargon in Summary/Business sections |
| Documentation sync | If diff adds new commands, changes structure, renames concepts, or adds new directories/scripts: check that at least one `docs:` commit exists on this branch OR ask the user to confirm docs are updated | PR does not silently ship structural changes without a corresponding docs update |
| Label validity | Every label in `suggestedLabels` exists in `repoLabels` | Zero fabricated labels |
| Forced label inclusion | Every label in `forcedLabels` appears in the final `suggestedLabels` list | Zero forced labels dropped |
| Link verification | Every URL in the body is validated by `scripts/skill/pr.js --validate-body` before `gh pr create` / `gh pr edit`. The script enforces — SKILL.md only invokes it. See the Link verification block in the publish step. | `LINK_EXIT === 0`; on non-zero, abort and surface violations |

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

Display format — create mode uses the `Labels:` line, update mode uses the `Existing labels`/`New labels` lines instead:

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

- **Create mode:** show `Labels:` only when `suggestedLabels` is non-empty; each entry carries its Step 2b provenance suffix — `(forced)` (CLI `--label` or ship-sdlc injection), `(rule)` (matched `pr.labels.rules`), or `(llm)` (fuzzy-matched, opt-in mode). Omit the line entirely when empty — never show "Labels: none".
- **Update mode:** show "Existing labels (preserved)" whenever `existingPr.labels` is non-empty; show "New labels" only when there are new suggestions. Omit either line when its list is empty — never show "Labels: none".

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

```shell
node "<PLUGIN_ROOT>/scripts/util/validate-pr-title.js" "$title" "$titlePattern" "$titlePatternError"
```

On failure:
- Show the error message from `prConfig.titlePatternError` (or the pattern itself as fallback)
- Do NOT create or edit the PR
- Ask the user to edit the title and retry

On success:
- Continue to link verification, label creation, and `gh pr create` / `gh pr edit`

**Link verification — HARD GATE:** Before executing `gh pr create` or `gh pr edit`, validate every URL embedded in the final PR body via `scripts/skill/pr.js --validate-body`. The script reads the body from stdin and derives the expected GitHub repo identity (`parseRemoteOwner(projectRoot)`) deterministically — the skill MUST NOT construct ctx JSON.

```shell
printf '%s' "$body" | node "<PLUGIN_ROOT>/scripts/skill/pr.js" --validate-body
LINK_EXIT=$?
```

On non-zero exit (`LINK_EXIT != 0`):
- The command has already printed the violation list to stderr (URL, line, reason code, observed/expected detail)
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

**Create mode:** issue the create through the `create-pr.js` wrapper described below — it is a transparent passthrough to `gh pr create` that only adds the post-failure recovery step. (What `create-pr.js` runs under the hood: `gh pr create --title "<title>" --body "<body>" [--draft] [--label "<l1>" --label "<l2>"]`.) The wrapper invocation below is the single publish path — do not run `gh pr create` directly first.

If no labels were approved, omit the `--label` flags entirely.

**Post-failure account-switch recovery:** Run the create step through the `create-pr.js` wrapper, which forwards every argument verbatim to `gh pr create` and — only if `gh` exits non-zero — captures its stderr to a temp file and invokes the recovery helper exactly once, printing the recovery verdict JSON on stdout:

```shell
RECOVER_JSON=$(node "<PLUGIN_ROOT>/scripts/util/create-pr.js" --title "<title>" --body "<body>" [--draft] [--label "<l1>" --label "<l2>"])
```

The wrapper exits 0 when `gh pr create` succeeded (nothing is printed), forwards `gh`'s own non-zero exit code after the recovery attempt, and exits 2 if the recovery helper could not be located.

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
4. **Flag risks** — call out migrations, permission changes, or config changes
5. **Preserve author intent** — if commit messages express design rationale, carry it into the description

## DO NOT

- Omit any section from the active template (default 8 or custom) — always include all defined sections
- Write generic descriptions ("various improvements", "code cleanup")
- Fabricate a JIRA ticket, business reason, or technical claim
- Execute `gh pr create` or `gh pr edit` without explicit user approval (unless `--auto` was passed)
- Skip the plan-critique-improve-do-critique-improve cycle before presenting to the user
- Run git or gh bash commands to gather data — all context comes from `PR_CONTEXT_JSON`

## Error Recovery

> **Flow**: detect → diagnose → auto-recover (retry once if transient) → invoke `error-report-sdlc` for persistent actionable failures.

| Error | Recovery | Invoke error-report-sdlc? |
|-------|----------|---------------------------|
| `skill/pr.js` node -e 'process.exit(1)' (`errors[]` present) | Show each error, stop | No — user input error |
| `skill/pr.js` node -e 'process.exit(2)' (crash) | Show stderr, stop | Yes |
| `gh pr create` fails with a `CreatePullRequest` permission error | Auto-recover per Step 6's account-switch retry (once); on no match, surface the original error + `gh auth login --hostname <host>` hint | No on first retry; Yes only if the retry also fails |
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

- **Large diff output**: `diffContent` can exceed 100KB, which truncates if piped through a
  shell parser (failure manifests as "Unterminated string in JSON at position N"). Always read
  `PR_CONTEXT_FILE` from disk (per Step 0) — never re-pipe `skill/pr.js` output manually.

- **Installed plugin version skew silently suppresses custom template**: `skill/pr.js` is
  resolved from the installed plugin, which may be older than the project's local copy and lack
  `customTemplate` support, returning it as absent/`null` even when `.sdlc/pr-template.md`
  exists. **Always cross-check**: if `customTemplate` is null, verify whether
  `.sdlc/pr-template.md` (or its deprecated fallback) exists on disk before defaulting to the
  8-section template; if it exists, read and use it directly, and warn the user the installed
  plugin may be out of date.

- **Multiple GitHub accounts**: pre-flight (`ensureGhAccount`) and the Step 6 post-failure
  account-switch retry (see Error Recovery) cover most mismatches automatically, surfacing one
  concise recovery line instead of the raw GraphQL error. Manual `gh auth switch --user <login>`
  before invoking the skill is still needed for collaborator scenarios where no local account
  login matches the repo owner.

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
