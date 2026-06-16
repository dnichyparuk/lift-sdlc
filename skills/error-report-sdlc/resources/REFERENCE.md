# Error-to-GitHub Issue Proposal — Procedure Reference

Used by `error-report-sdlc`. Follow every section in order.

---

## Section 1: Error Classification

Only proceed with a GitHub issue proposal for **issue-worthy** errors. Skip silently for all others.

**Issue-worthy** (proceed with proposal):

| Error | Examples |
|---|---|
| Prepare script crash | Exit code 2 from any `*-prepare.js` script |
| CLI tool failure | `gh pr create` / `gh pr edit` fails with non-auth error; `git tag` or `git push` fails |
| Persistent API error | HTTP 400/5xx on the same external API operation 2+ times in a row |
| Persistent conflict | HTTP 409 that persists after one retry |
| Escalated task failure | Task in `execute-plan-sdlc` fails after 2 retries |
| Build failure blocking execution | Build fails and blocks wave progression |

**NOT issue-worthy** (skip proposal, continue normal error handling):

| Error | Reason |
|---|---|
| Exit code 1 from prepare script | User input error — missing config, wrong args |
| HTTP 401 | Auth token expired — user action needed |
| HTTP 403 | Insufficient permission — user action needed |
| HTTP 404 on issue key | User typo — not a bug |
| User cancellation | Intentional — not an error |
| Lint-only failure | Low severity, auto-fixable |
| Missing project key / config | User setup — not a bug |
| `gh auth` not logged in | User setup — not a bug |

---

## Section 2: Pre-flight Verification

Run these checks before offering the proposal. If any required check fails, **skip the proposal silently** and return to the calling skill's normal error handling.

**Check 1 — gh CLI available and authenticated:**

```bash
gh auth status
```

If the command fails (exit non-zero) → skip proposal. The user's GitHub CLI is not configured or not authenticated.

**Check 2 — GitHub remote resolvable:**

```bash
REPO_URL=$(git remote get-url origin 2>/dev/null)
```

If `REPO_URL` is empty or the command fails → skip proposal.

Store `TARGET_REPO=dnichyparuk/antigravity-sdlc` — this is the fixed repository for all tooling error reports.

---

## Section 3: Consent Gate 1 — Offer

Present this prompt to the user:

```
This error may be worth tracking as a GitHub issue. Create one? (yes / no)
  yes — I'll draft the issue with the full error context for your review
  no  — skip, continue with normal error handling
```

**On `no`:** Return to the calling skill's normal error handling immediately. Do not proceed.

**On `yes`:** Continue to Section 4.

---

## Section 4: Assemble Issue Content

> **As of issue #202:** Template assembly (reading this template, filling placeholders,
> building the title) is delegated to the `error-report-orchestrator` agent (SKILL.md
> Step 4). This section documents the template structure and placeholder sources for
> reference. The orchestrator receives the manifest from `error-report-prepare.js` and
> applies the rules below internally.

Read `./templates/ToolingError.md` (locate via Glob: `**/error-report-sdlc/templates/ToolingError.md` under `~/.gemini/config/plugins`, then cwd fallback).

Fill all `{placeholder}` markers using the context provided by the calling skill:

| Placeholder | Source |
|---|---|
| `{what failed — one line}` | Summarize the error in one sentence |
| `{skill name}` | The calling skill's name (e.g., `pr-sdlc`) |
| `{step number and name}` | The step where the error occurred |
| `{what the skill was trying to do}` | The operation being attempted |
| `{ISO timestamp}` | Current timestamp in ISO 8601 format |
| `{script crash \| CLI failure \| ...}` | Pick the matching error type |
| `{code}` | Exit code or HTTP status |
| `{full error text}` | Complete error message or output |
| `{repository name from git remote}` | Run `git remote get-url origin` or use `git remote -v` |
| `{current branch}` | Run `git branch --show-current` |
| `{what the user was doing}` | Describe the user's intent |
| `{with arguments if any}` | Arguments the skill was invoked with |
| `{step that failed and why}` | The specific step and failure reason |
| `{what was blocked}` | What could not complete |
| `{skill-specific hints}` | The `Suggested investigation` from the calling skill |

Remove any section where no applicable content exists. Do NOT leave raw `{placeholder}` text in the final description.

Determine priority:
- **High**: Script crash (exit 2), build failure blocking waves
- **Medium**: CLI failure, persistent API error, escalated task failure

Build the title: `[{skill-name}] {one-line error summary}` (max 72 chars).

---

## Section 5: Consent Gate 2 — Review

Present the assembled issue to the user:

```
Proposed GitHub Issue:
───────────────────────────────────────────
Title:    {assembled title}
Priority: {High | Medium}
Labels:   tooling-error, {skill-name}

Description:
{filled template content}
───────────────────────────────────────────
Create this issue? (yes / edit / cancel)
  yes    — create the issue as shown
  edit   — tell me what to change
  cancel — skip issue creation
```

If the user says `edit`: apply the requested changes, re-present. Loop until `yes` or `cancel`.

**On `cancel`:** Return to the calling skill's normal error handling. Do not create anything.

**On `yes`:** Continue to Section 6.

---

## Section 6: Create the GitHub Issue

**6a. Create the issue:**

```bash
gh issue create \
  --repo "dnichyparuk/antigravity-sdlc" \
  --title "<assembled title>" \
  --body "<filled template content>" \
  --label "tooling-error" \
  --label "<skill-name>"
```

If a label does not exist on the repository, `gh` will error. In that case, attempt to create the missing label first:

```bash
gh label create "tooling-error" --repo "dnichyparuk/antigravity-sdlc" --color "d93f0b" 2>/dev/null || true
gh label create "<skill-name>" --repo "dnichyparuk/antigravity-sdlc" --color "0075ca" 2>/dev/null || true
```

Then retry `gh issue create`. If it still fails, proceed to 6c.

**6b. On success:** Report the created issue number and URL:

```
GitHub issue created: #<number> — <url>
```

**6c. On failure:** Report the error without retrying:

```
Could not create GitHub issue: <error>
```

Then return to the calling skill's normal error handling.

---

## Section 7: Return to Calling Skill

After Section 6 (whether the issue was created, skipped, or failed), **always return control to the calling skill's error handling**. This procedure is additive — it never replaces the skill's own error output or stop behavior.

---

## DO NOT

- Propose for user input errors, auth/permission failures, or user cancellations
- Create an issue without both consent gates passing (Sections 3 and 5)
- Retry a failed gh issue create call
- Leave `{placeholder}` text in the issue description
- Block the calling skill's normal error flow
