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

Run before offering the proposal. If either check fails, **skip the proposal
silently** and return to the calling skill's normal error handling.

```bash
gh auth status                                      # must exit 0 — gh CLI configured & authenticated
REPO_URL=$(git remote get-url origin 2>/dev/null)   # must be non-empty — GitHub remote resolvable
```

Store `TARGET_REPO=dnichyparuk/lift-sdlc` — the fixed repository for all tooling error reports.

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

Template assembly (reading `templates/ToolingError.md`, filling every `{placeholder}`
from the manifest, building the title, removing sections with no applicable content)
is delegated to the `error-report-orchestrator` agent (SKILL.md Step 4) — see
`agents/error-report-orchestrator.md` for the authoritative placeholder-to-manifest
mapping. Do NOT leave raw `{placeholder}` text in the final description.

Priority: **High** for a script crash (exit 2) or a build failure blocking waves;
**Medium** for everything else issue-worthy. Title format:
`[{skill-name}] {one-line error summary}` (max 72 chars).

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
  --repo "dnichyparuk/lift-sdlc" \
  --title "<assembled title>" \
  --body "<filled template content>" \
  --label "tooling-error" \
  --label "<skill-name>"
```

If a label does not exist on the repository, `gh` will error. In that case, attempt to create the missing label first:

```bash
gh label create "tooling-error" --repo "dnichyparuk/lift-sdlc" --color "d93f0b" 2>/dev/null || true
gh label create "<skill-name>" --repo "dnichyparuk/lift-sdlc" --color "0075ca" 2>/dev/null || true
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

- Propose for a NOT issue-worthy error (Section 1)
- Create an issue without both consent gates passing (Sections 3 and 5)
- Retry a failed gh issue create call
- Leave `{placeholder}` text in the issue description
- Block the calling skill's normal error flow
