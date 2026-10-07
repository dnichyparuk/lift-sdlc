# AGENTS.md — lift-sdlc

Rules for agents (and people) changing this repository. Keep them short; follow them exactly.

## 1. What this repo is

- `lift-sdlc` is a plugin for the **Antigravity CLI** (`agy`). It is the Antigravity counterpart
  of the Claude Code `sdlc` plugin: skills, agents and hooks for plans, execution, commits,
  reviews, PRs and releases.
- It **must comply with the official Antigravity plugin specification**. Sources:
  - Plugins (CLI tab): https://antigravity.google/docs/plugins?tab=cli
  - Hooks: https://antigravity.google/docs/hooks
  - Skills: https://antigravity.google/docs/skills
  - Subagents: https://antigravity.google/docs/subagents
  - Rules (how this `AGENTS.md` is loaded): https://antigravity.google/docs/rules
- Schemas verified against the docs and `agy` are recorded in
  [`docs/plugin-api-specs.md`](docs/plugin-api-specs.md) (§2 "Confirmed Antigravity Schemas and
  Conventions", §3 compatibility analysis). Update that file when you verify something new.
- Do **not** port Claude Code conventions where the spec differs. Port behaviour from the Claude
  Code `sdlc` plugin only when the Antigravity spec says nothing to the contrary.
- In skills and agent prompts, use Antigravity native tool names (`view_file`, `write_to_file`,
  `replace_file_content`, `multi_replace_file_content`, `find_by_name`, `grep_search`,
  `run_command`, `ask_question`, `invoke_subagent`), never Claude Code ones (`Read`, `Edit`,
  `Write`, `Bash`, `Agent`, `AskUserQuestion`, ...).
- Skill frontmatter: the spec documents `name` and `description`. Do not add new fields; the
  existing `argument-hint` / `user-invocable` are a repo convention and must not be load-bearing.

## 2. Mandatory checks before every commit and PR

All must pass. Never weaken, skip or loosen a test or validator to make it pass. Fix the code,
or raise the problem with the owner.

```bash
npm ci                       # once per clone
npm test                     # node --test over scripts/, skills/, hooks/
npm run lint                 # eslint scripts skills — zero errors
npm run check:refs           # skill → script references
npm run check:plugin         # plugin.json / hooks.json / skills / agents schema
npm run check:discovery
agy plugin validate .        # official validator
npm run test:learning-loop   # also required when learning-loop code changes
                             # (skills/learn-sdlc, scripts/skill/learn-*.js, scripts/lib/learnings.js)
```

- If `agy` is not installed or cannot run, say so in the PR's "Spec compliance" section and do
  not claim the plugin was validated. `npm run check:plugin` is still required, but it does not
  replace `agy`.
- Other validators in `scripts/ci/` (`validate-plan-format.js`, `validate-guardrails.js`, ...)
  must pass for any input you change that they check.

## 3. Branches, commits, PRs, releases

- Work on a branch from `main`, never on `main` itself. One topic per branch/PR. Stack a PR on
  another one only when they truly overlap, and say so in the PR.
- Commits: Conventional Commits (`feat(scope): ...`, `fix(...)`, `docs(...)`, `chore(release): ...`),
  imperative, English.
- PR description: **Summary**, **Test plan** (each check from §2 with its result) and
  **Spec compliance** (what was checked, against which source page and date, and every
  deviation, new or pre-existing, that the change touches).
- **Version bump and changes log in every PR that changes the plugin** (convention of #14–#20):
  - a separate last commit `chore(release): bump plugin version to X.Y.Z`;
  - it raises the version in `package.json`, `package-lock.json` (both `version` fields),
    `plugin.json`, and the `brand-tag` in `explorer/index.html` and `explorer/sdlc_explorer.html`;
  - patch for fixes, minor for features or behaviour changes (SemVer);
  - add an entry to [`docs/changes-log.md`](docs/changes-log.md) (there is no `CHANGELOG.md`):
    `## <title>`, `**Date:** YYYY-MM-DD`, `**Version:** X.Y.Z`, then Overview / Changes Made /
    Impact.
- PRs are merged with **merge commits** ("Merge pull request #N ..."), not squash or rebase.
  Agents do not merge PRs unless the owner explicitly says so.

## 4. Where things live

| Path | What |
|---|---|
| `plugin.json`, `hooks.json` | Plugin manifest and hook registration |
| `skills/<name>/SKILL.md` (+ `resources/`) | Skills |
| `agents/*.md` | Registered subagents (dispatched with `invoke_subagent`) |
| `hooks/*.js` | Hook handlers (stdin `toolCall` → stdout `{decision, reason}`) |
| `scripts/skill/` | Prepare/CLI scripts called by skills |
| `scripts/lib/` | Shared libraries (e.g. `plan-checkboxes.js`, `plan-indexer/`) |
| `scripts/ci/` | Validators and CI helpers (`validate-*.js`) |
| `schemas/` | JSON schemas (e.g. `delivery-graph.schema.json`) |
| `templates/` | Files deployed to user projects (plan guidelines, dashboard, workflows) |
| `.sdlc/review-dimensions/`, `.github/instructions/` | Review criteria used by `review-sdlc` |
| `docs/` | Specs, architecture and the changes log |

- Plan format, including acceptance-criteria boxes and the skipped `- [~]` rule (syntax, required
  comment, counting, PF5/PF6, who may set it):
  [`skills/plan-sdlc/resources/plan-format-reference.md`](skills/plan-sdlc/resources/plan-format-reference.md).
  The project-facing version is `templates/guidelines/PLAN_GUIDELINES.md`. Keep its copy
  `skills/plan-guide-sdlc/PLAN_GUIDELINES.md` identical to it.
