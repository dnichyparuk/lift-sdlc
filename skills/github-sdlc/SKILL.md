---
name: github-sdlc
description: "Use this skill when creating, editing, reading, viewing, searching, commenting on, or managing GitHub issues. Leverages the GitHub CLI (gh) to interact with issues directly. Arguments: [--repo <owner/repo>]. Triggers on: create github issue, edit github ticket, search github, github comment, assign github, manage github, github template, read github, view github, show github, get github, fetch github, github details, add comment, comment on github, reply to github, github ticket, github issue."
user-invocable: true
argument-hint: "[--repo <owner/repo>]"
model: gemini-3.8-flash-medium
---

# Managing GitHub Issues

Execute any GitHub Issue operation — create, edit, search, view, comment, assign,
close, or reopen — using the GitHub CLI (`gh issue`).

**Announce at start:** "I'm using github-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

## Step 0 — Verification

Verify that the `gh` CLI is installed and authenticated.

> **VERBATIM** — Run these commands exactly as written. Do not modify, rephrase, or simplify them.

```bash
gh auth status >/dev/null 2>&1
GH_AUTH_STATUS=$?
if [ $GH_AUTH_STATUS -ne 0 ]; then
  echo "ERROR: Not authenticated with GitHub CLI. Please run 'gh auth login'." >&2
  exit 1
fi
```

If the command fails, display the error to the user and stop.

## Step 1 — Plan and Critique

For a modifying command (`create`, `edit`, `comment`, `close`, `reopen`), draft the content (title, body, labels/assignees, or comment text) and check it against these gates:

| Gate | Pass Criteria |
| ---- | ------------- |
| Specificity | No vague titles like "Fix issue" — name a concrete change or bug |
| Context | Body is not empty; includes reproduction steps or business context |
| Markdown | Valid markdown formatting |

Read-only operations (`view`, `list`) skip straight to Step 3 — no draft, no approval.

## Step 2 — User Approval (Modifying Operations Only)

Present the drafted content, e.g.:

```text
Action: Create Issue
Title: <title>
Body:
─────────────────────────────────────────────
<drafted body>
─────────────────────────────────────────────
Labels: <labels>
Assignees: <assignees>
```

Then use AskUserQuestion:
> Execute this GitHub operation?
> Options: **yes** — execute | **edit** — tell me what to change | **cancel** — abort

If the user chooses `edit`, ask what to change, revise, and present again. Loop until explicit `yes` or `cancel` — never execute a modifying command without this approval, including operations like `close` and `reopen`.

## Step 3 — Execute

| Operation | Command |
| --- | --- |
| Create | `gh issue create --title "<title>" --body "<body>" [--assignee "<user>"] [--label "<label>"] [--repo "<repo>"]` |
| Edit | `gh issue edit <issue_number> [--title "<title>"] [--body "<body>"] [--add-assignee "<user>"] [--add-label "<label>"] [--repo "<repo>"]` |
| Comment | `gh issue comment <issue_number> --body "<body>" [--repo "<repo>"]` |
| Close | `gh issue close <issue_number> [--reason "<reason>"] [--repo "<repo>"]` |
| Reopen | `gh issue reopen <issue_number> [--repo "<repo>"]` |
| View | `gh issue view <issue_number> [--repo "<repo>"]` |
| Search/List | `gh issue list [--state <open\|closed\|all>] [--label "<label>"] [--assignee "<user>"] [--search "<query>"] [--repo "<repo>"]` |

On success, surface the output or URL to the user. If `gh` fails, show the error — for a permission error, suggest the user verify their repository permissions or re-run `gh auth login` with the appropriate scopes.

## DO NOT

- Guess issue numbers. Use `gh issue list` or search if the user provides a vague description.
