---
name: github-sdlc
description: "Use this skill when creating, editing, reading, viewing, searching, commenting on, or managing GitHub issues. Leverages the GitHub CLI (gh) to interact with issues directly. Arguments: [--repo <owner/repo>]. Triggers on: create github issue, edit github ticket, search github, github comment, assign github, manage github, github template, read github, view github, show github, get github, fetch github, github details, add comment, comment on github, reply to github, github ticket, github issue."
user-invocable: true
argument-hint: "[--repo <owner/repo>]"
model: gemini-3.5-flash-medium
---

# Managing GitHub Issues

Execute any GitHub Issue operation — create, edit, search, view, comment, assign,
close, or reopen — using the GitHub CLI (`gh issue`).

**Announce at start:** "I'm using github-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

## When to Use This Skill

- Creating, editing, or viewing GitHub issues
- Adding comments to GitHub issues
- Assigning issues or adding labels/milestones
- Searching for issues via `gh issue list`
- When the user asks anything GitHub Issue-related

## Step 0 — Verification

Verify that the `gh` CLI is installed and authenticated.

> **VERBATIM** — Execute this script directly using its absolute path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin. Note the strict script location pattern: `<PLUGIN_ROOT>/skills/<skill-name>/scripts/<script-name>.sh`). Do NOT prepend `bash` or `sh`.

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

Before executing a modifying command (`create`, `edit`, `comment`, `close`, `reopen`), draft the content and verify its completeness.

- **Create**: Draft the title, body, and determine necessary labels/assignees.
- **Edit**: Draft the modifications (title changes, body additions, label additions/removals).
- **Comment**: Draft the comment body.

### Quality Gates

Check the draft against the following gates:

| Gate | Check | Pass Criteria |
| ---- | ----- | ------------- |
| Specificity | Title names a concrete change or bug | No vague titles like "Fix issue" |
| Context | Body includes reproduction steps or business context | Body is not empty |
| Markdown | Content uses proper markdown formatting | Valid markdown |

If the operation is purely read-only (`view`, `list`), skip to Step 2.

## Step 2 — User Approval (Modifying Operations Only)

For any modifying operation (`create`, `edit`, `comment`, `close`, `reopen`), present the drafted content or action to the user and request explicit approval via AskUserQuestion.

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

Use AskUserQuestion to ask:
> Execute this GitHub operation?
> Options: **yes** — execute | **edit** — tell me what to change | **cancel** — abort

If the user chooses `edit`, ask what to change, revise, and present again.
Loop until explicit `yes` or `cancel`.

## Step 3 — Execute

Execute the corresponding GitHub CLI command.

**Create:**
```bash
gh issue create --title "<title>" --body "<body>" [--assignee "<user>"] [--label "<label>"] [--repo "<repo>"]
```

**Edit:**
```bash
gh issue edit <issue_number> [--title "<title>"] [--body "<body>"] [--add-assignee "<user>"] [--add-label "<label>"] [--repo "<repo>"]
```

**Comment:**
```bash
gh issue comment <issue_number> --body "<body>" [--repo "<repo>"]
```

**View:**
```bash
gh issue view <issue_number> [--repo "<repo>"]
```

**Search/List:**
```bash
gh issue list [--state <open|closed|all>] [--label "<label>"] [--assignee "<user>"] [--search "<query>"] [--repo "<repo>"]
```

On success, surface the output or URL to the user.
If `gh` fails, show the error.

## DO NOT

- Execute modifying commands (`create`, `edit`, `comment`, `close`, `reopen`) without explicit user approval.
- Guess issue numbers. Use `gh issue list` or search if the user provides a vague description.

## Error Recovery

If `gh` commands fail with a permission error, suggest that the user verifies their permissions for the repository or runs `gh auth login` with the appropriate scopes.
