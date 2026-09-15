# execute-plan-sdlc — Gotchas and What's Next

Reference material moved out of `SKILL.md` to keep the activated skill body smaller
(progressive disclosure). Read the **Gotchas** once before Step 5 (DO); read **What's Next**
when Step 9 (REPORT) is reached.

## Gotchas

**Agent context isolation is critical.** Agents have no memory of other agents' work. Every agent prompt must include the full task text, the exact file list, and relevant output from prior waves. A task title without its body produces hallucinated implementations.

**File conflicts have a blind spot.** Two tasks may not list the same file but still conflict — for example, Task A creates a module and Task B modifies the barrel file that re-exports it. The dependency graph catches explicit file dependencies but not implicit ones (barrel files, config registrations, index files). Check for these during inter-wave critique (Step 5e).

**Trivial pre-wave aggregation has a scope trap.** Only move trivial tasks into pre-wave if they have downstream dependents (e.g., adding an env variable Wave 1 reads). Independent documentation updates don't need to run pre-wave — moving them there delays Wave 1 for no reason.

**Batch agent ordering matters for same-file trivials.** When 2+ trivial tasks in a batch touch the same file, include an Ordering Constraints section in the batch prompt that lists the required sequence. Without it, the agent may apply edits in the wrong order and the second edit will conflict with the first.

**Partial batch failure requires per-task extraction.** When a batch agent reports some tasks as SUCCESS and others as FAILED, do not re-dispatch the entire batch. Extract only the failed tasks and re-dispatch each individually with model escalation (gemini-3.8-flash-low → gemini-3.8-flash-medium). Completed tasks in the batch are final — re-running them risks duplicate changes.

**Plan drift compounds across waves.** After 3+ waves, the codebase may differ significantly from what the plan assumed. The inter-wave critique (Step 5e) exists specifically to catch this. Skipping it on "obvious" waves is where cascading failures begin.

**Wave sizing heuristics are guidelines.** On resource-constrained systems or when tasks share state (databases, caches), reduce wave size to 2–3 regardless of the heuristic table.

**Model escalation is not a retry substitute.** Escalating from gemini-3.8-flash-medium to gemini-3.8-flash-high (or gemini-3.8-flash-high to gemini-3.1-pro-low) gives the agent more capability, but if the failure was caused by a bad prompt or insufficient context, a stronger model won't help. Always add failure context to the retry prompt regardless of model change. Escalation consumes one of the 2 allowed retries.

**Agents may bypass native editing tools.** Agents sometimes use bash `sed`, `awk`, Python scripts, or compiled programs in `/tmp` to modify files instead of `replace_file_content` or `write_to_file`. These approaches are fragile (wrong line numbers, regex mismatches, wrong working directory) and silently fail — the agent reports success, but the file is unchanged or corrupted. The Hard Constraints in the agent prompt forbid this, but the filesystem verification in Step 5c catches cases where the constraint was ignored.

**Worktree lifecycle is script-driven, not harness tools.** `util/worktree-create.js` handles creation (including branch collision) — no EnterWorktree/ExitWorktree. See What's Next for the cleanup script sequence.

**State files are script-managed.** Use state/execute.js for all state operations. Don't hand-write JSON to `.sdlc/execution/`.

**State file timestamp is set once at execution start.** The `<timestamp>` in the filename is established when execution begins and does not change across waves. The same file is overwritten after each wave. This keeps the filename stable for resume detection and ship-sdlc integration.

**Resume context object enables fresh-session resume.** The `context` object in the state file exists for cross-session resume where the new session has no conversation history. It must contain enough information (plan summary, completed task IDs, file manifests, interface names, key decisions) for the orchestrator to construct meaningful agent prompts for remaining waves. Omitting context fields degrades agent output quality on resume.

**State file and ship-sdlc coexistence.** Both `execute-plan-sdlc` and `ship-sdlc` write state files to `.sdlc/execution/`, distinguished by filename prefix (`execute-` vs `ship-`); each skill manages its own state file lifecycle only — see DO NOT for the boundary this skill must not cross.

**Guardrail evaluation is LLM-based, not programmatic.** Guardrails are natural-language descriptions evaluated by the orchestrator against task descriptions (pre-wave) and `git diff` output (post-wave). They catch semantic drift (e.g., "no direct DB access" when a task adds raw SQL), not syntactic violations. False positives are possible — the override option exists for this reason.

**Guardrails complement spec compliance review.** Step 5c-bis checks spec compliance; Step 5c-ter checks guardrail compliance. They are complementary: spec review ensures tasks match their descriptions, guardrails ensure tasks match project-wide constraints. Do not merge them — they evaluate different things.

## What's Next

After completing plan execution, common follow-ups include:
- `/commit-sdlc` — commit the changes
- `/review-sdlc` — review the changes
- `/version-sdlc` — tag a release
- `/pr-sdlc` — create a pull request

If `openspecSpecs` was loaded in Step 1 (the plan was OpenSpec-sourced), also suggest archive-related next steps — but gate on validation first:

1. Extract the change name from the plan header's `**Source:**` field (the `openspec/changes/<name>/` path).
2. Call `lib/openspec.js::validateChangeStrict(projectRoot, name)` via Bash:
   ```shell
   OPENSPEC_VALIDATE_FILE=$(node "<PLUGIN_ROOT>/scripts/util/openspec-validate.js" '<name>')
   ```
   > **Contract (Input/Output):**
   > - **Input**: the change name as a single positional argument.
   > - **Output**: prints the path of a temp JSON file on stdout — **not** the JSON itself. Capture that path into `OPENSPEC_VALIDATE_FILE`, `JSON.parse` the file, and take `{ ok, stdout, stderr, cliAvailable, errors }` from it. Exit 0 when `ok` is true, 1 when validation failed, 2 on an unexpected crash.
3. **If `cliAvailable === false`:** emit the existing static advisory (no fabricated validation claim):
   - `/opsx:verify` — validate implementation completeness against the spec
   - `/opsx:archive` — merge delta specs into main specs after verification passes
4. **If `ok === true`:** apply the tasks.md coverage gate before emitting the suggestion:
   - Re-parse `openspec/changes/<name>/tasks.md` via the tasks CLI:

     ```shell
     TASKS_JSON=$(node "<PLUGIN_ROOT>/scripts/util/openspec-tasks.js" --change "<name>")
     ```

     > **Contract (Input/Output):**
     > - **Input**: `--change "<name>"` (the flag is `--change`; `--name` is kept as a backward-compatible alias).
     > - **Output**: `TASKS_JSON` is an **envelope object**, not a bare array — `{"status":"success","tasks":[{ref,line,title,indent,done}, ...]}` on exit 0, or `{"status":"error","error":"<message>"}` on exit 1. Always read the task list from `TASKS_JSON.tasks`.

     Build `unflippedTitles` from the entries of `TASKS_JSON.tasks` where `done === false`.
   - Parse the plan file's `## Out-of-scope OpenSpec tasks` section (a flat bullet list of `- <title> — <rationale>` items) into `outOfScopeTitles: Set<string>` (case-sensitive title match).
   - Compute `undocumentedUnflipped = unflippedTitles.filter(t => !outOfScopeTitles.has(t))`.
   - If `undocumentedUnflipped.length === 0`: emit the validated suggestion as before:
     ```
     OpenSpec validation passed for change "<name>".
     → Run `openspec archive <name> --yes` to archive, or use `/ship-sdlc` which handles archival as a pipeline step.
     ```
   - If `undocumentedUnflipped.length > 0`: SUPPRESS the archive suggestion and emit the diagnostic listing — derived from `refToTaskIds` (built in Step 1):
     ```
     OpenSpec tasks incomplete — archive suggestion suppressed.
     Unflipped tasks (not in `## Out-of-scope OpenSpec tasks`):
       line <N>: <title> — expected from plan task(s) <id>...
       ...
     Fix the underlying plan-task failures or add these titles to `## Out-of-scope OpenSpec tasks` and re-run.
     ```
     When a title's `ref` is not in `refToTaskIds` at all, render `(no plan task carries this ref)` in place of the plan-task ID list. This skill MUST NOT call `lib/openspec.js::runArchive` — archival is deferred (preserves the "execute only" boundary).
5. **If `ok === false`:** emit the validation errors and suppress the archive suggestion:
   ```
   OpenSpec validation failed for change "<name>":
   <stderr output>
   Fix validation issues before archiving.
   ```

The archive suggestion is **never auto-executed** — this skill is the "execute only" entry point. Archival is deferred to `/ship-sdlc` or manual invocation.

If execution started in a worktree (Step 1 workspace isolation) and running standalone (not invoked from ship-sdlc), clean up through the worktree lifecycle script — resolve the worktree for the execution branch, then remove it by path:

```bash
node "<PLUGIN_ROOT>/scripts/util/worktree-lifecycle.js" resolve --branch <EXECUTE_NEW_BRANCH>
node "<PLUGIN_ROOT>/scripts/util/worktree-lifecycle.js" remove --path <path>
```

`resolve` prints `{"found":true,"path":"...","mainWorktree":"...","branch":"..."}` when the branch has a linked worktree, or `{"found":false,"mainWorktree":"..."}` when it does not — skip the `remove` call entirely when `found` is false. `remove` runs from the resolved main worktree and refuses to delete it (exit 1 with `{"error":"refusing to remove the main worktree"}`); on success it prints `{"removed":true,"path":"..."}`. When invoked from ship-sdlc, skip cleanup — ship-sdlc owns the worktree lifecycle.
