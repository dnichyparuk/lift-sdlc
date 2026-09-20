# ship-sdlc — Gotchas, Learning Capture and What's Next

Reference material moved out of `SKILL.md` to keep the activated skill body smaller
(progressive disclosure). Read **Gotchas** once before Step 5 (EXECUTE); apply **Learning
Capture** and **What's Next** in Step 6 (REPORT).

## Gotchas

**Verdict detection is text-based.** Parse the conversation for a line matching `Verdict: <VERDICT>`. The review-sdlc orchestrator always emits this. If the conversation is compacted between review and verdict parsing, the verdict may be lost — treat missing verdict as APPROVED WITH NOTES and warn the user.

**Double commit is intentional.** Feature commit (step 2) and review fix commit (step 5) are separate. This keeps feature work and review fixes distinct in git history. Do not squash them.

**Config file is optional.** The pipeline runs with built-in defaults when no ship config exists in `.sdlc/local.json`. Do not error on missing config.

**.sdlc/ must be gitignored** (see Step 1c's warning) **as the primary defense** — `ship-git-ops.js stage-post-execute`'s `git add` excluding `.sdlc/` is only a fallback.

**State files are script-managed.** Use state/ship.js / state/execute.js for all state operations. Don't hand-write JSON to `.sdlc/execution/`.

**Worktree lifecycle is script-driven.** `util/worktree-create.js` to create (handles branch collision), `util/worktree-lifecycle.js resolve` + `remove` to clean up. Never use EnterWorktree/ExitWorktree.

**Worktree state is not persisted.** Git is the source of truth: branch name + `util/worktree-lifecycle.js resolve --branch <branch>` yields the worktree path. Do not add worktree fields to state files.

**Worktree mode changes the version and PR steps.** `computeSteps` in skill/ship.js auto-skips the version step when `workspace === 'worktree'` (tags are repo-global) and adds `--label skip-version-check` to the PR step args so `gh pr create` carries the label from creation. Only worktree auto-skip triggers the label, not a `version` omitted from `ship.steps[]`; the label must already exist in the repository (pr-sdlc creates it if missing). Print the post-merge advisory (see "Post-pipeline advisory" above).

**Auto mode does not auto-resume without --resume.** When `--auto` is set but `--resume` is not, the pipeline starts fresh even if a state file exists for the current branch. The state file is preserved (not deleted) so the user can explicitly `--resume` later.

---

## Learning Capture

After completing the pipeline, append to `.sdlc/learnings/log.md`:

- Review verdicts that surprised (threshold too aggressive or too lenient)
- Sub-skills that failed in unexpected ways during chaining
- Config combinations that produced unintended pipeline shapes
- Projects where the default `steps[]` behavior was wrong, or migrations from legacy v1 configs (`ship.preset`/`ship.skip`) that produced unexpected `steps[]` after auto-migration. CLI `--preset`/`--skip` are no longer accepted; ship-sdlc emits a migration-pointer error if either is passed.

Format:
```
## YYYY-MM-DD — ship-sdlc: <brief summary>
<what was learned>
```

---

## What's Next

After the pipeline completes, common follow-ups include:
- `/received-review-sdlc` — address deferred medium/low findings
- `/opsx:verify` — validate implementation against OpenSpec (if detected)
- `/opsx:archive` — archive the OpenSpec change and sync delta specs (if detected)

---
