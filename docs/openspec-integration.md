# OpenSpec Integration

This document describes how the SDLC plugin integrates with **OpenSpec**—a lightweight, spec-driven development and task-tracking format—to bridge planning, execution, commit management, and archival workflows.

---

## Overview

The SDLC plugin leverages OpenSpec's structured change format to automatically align feature requirements with implementation plans, track code completion down to the task level, associate commit histories with active specifications, and handle final change archival as a pipeline-integrated step.

---

## OpenSpec Project Structure

When a project is configured with OpenSpec, it contains the following file system layout:

```
<project_root>/
└── openspec/
    ├── config.yaml          # Core OpenSpec configuration
    ├── specs/               # Baseline specification markdown files
    └── changes/             # Directory containing active feature changes
        ├── archive/         # Archived feature changes (e.g. after ship)
        └── <change-name>/   # A single active feature change directory
            ├── proposal.md  # High-level goals and context of the change
            ├── design.md    # Architecture and design decisions (optional)
            ├── tasks.md     # Checkbox list of tasks to complete
            └── specs/       # Delta specification files detailing requirements
```

---

## Core Utilities

The primary OpenSpec utilities are located in [openspec.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/lib/openspec.js). These zero-dependency utilities handle filesystem analysis, task parsing, validation, and archival.

### 1. Stage Derivation
An active change's lifecycle status is derived from the progress of checkboxes inside its `tasks.md` file:
* **`spec-in-progress`**: `tasks.md` does not exist or has zero tasks.
* **`ready-for-plan`**: `tasks.md` exists and is populated, but zero tasks are marked complete (`- [ ]`).
* **`implementation-in-progress`**: Some, but not all, tasks are marked complete (`- [x]`).
* **`tasks-complete`**: All tasks listed in `tasks.md` are marked complete.

### 2. Task Reference Commenting
To prevent task-drift or broken references when a user rewords a task description, the plugin utilizes deterministic reference comment anchors. 
* **Hash Generation**: In [openspec.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/lib/openspec.js#L365), a stable hash is generated from a slugified version of the task's title.
* **Ref Injection**: During planning preparation, the plugin inserts a comment `<!-- ref:<hash> -->` at the end of each task line in `tasks.md` to persist the identity of the task.

### 3. Task Flipping
The `markTaskDone` function in [openspec.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/lib/openspec.js#L437) resolves a task to complete by matching:
1. An inline `<!-- ref:<hash> -->` comment.
2. A line number hint + matching title prefix.
3. An exact string title match.

Once matched, it replaces the `- [ ]` box with `- [x]` in `tasks.md` while preserving the rest of the line.

---

## Lifecycle Integration

```mermaid
graph TD
    subgraph Setup
        A["/setup-sdlc"] -->|"Enrich config"| B["openspec/config.yaml"]
    end

    subgraph Planning
        C["/plan-sdlc --from-openspec"] -->|"Read specs & proposal"| D["Explore Pack (plan-explore.js)"]
        D -->|"Identify tasks"| E["Generate plan.md"]
        E -->|"Add metadata annotations"| F["openspec-task: change, ref, line, title"]
    end

    subgraph Execution
        G["/execute-plan-sdlc"] -->|"Complete plan task"| H["markTaskDone (openspec_wrapper.sh)"]
        H -->|"Flip tasks.md [ ] to [x]"| I["openspec/changes/&lt;change-name&gt;/tasks.md"]
    end

    subgraph Commit
        J["/commit-sdlc"] -->|"Match current Git branch slug"| K["Insert OpenSpec-Change: trailer"]
    end

    subgraph Shipping
        L["/ship-sdlc"] -->|"Validate"| M["openspec validate &lt;name&gt; --strict"]
        M -->|"Archive"| N["openspec archive &lt;name&gt; --yes"]
        N -->|"Commit archive"| O["chore(openspec): archive &lt;name&gt;"]
    end
```

### 1. Planning (`/plan-sdlc`)
When a developer initiates planning from an active change (`/plan-sdlc --from-openspec <change-name>`):
* **Context Loading**: [plan.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/skill/plan.js) parses the target change directory and exposes its tasks, specs, and proposal to the plan-reviewer subagent.
* **Direct Mapping**: The agent maps each OpenSpec task to one or more implementation tasks inside the generated plan.
* **Traceability Metadata**: Every plan task derived from an OpenSpec task receives an `openspec-task:` metadata annotation:
  ```yaml
  openspec-task:
    change: add-oauth2-pkce
    ref: configure-pkce-flow-a7e1f4
    line: 12
    title: Configure authorization endpoint PKCE support
  ```
* **Coverage Enforcement (G16 Gate)**: The plan reviewer validates that all OpenSpec tasks are accounted for. Any task not implemented must be explicitly listed under `## Out-of-scope OpenSpec tasks` along with a rationale.

### 2. Execution (`/execute-plan-sdlc`)
During autonomous code execution:
* **Flipping Progress**: As tasks within a plan are successfully implemented and verified, the runner identifies their matching `openspec-task` annotations.
* **Synchronization**: The runner invokes [openspec_wrapper.sh](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/execute-plan-sdlc/scripts/openspec_wrapper.sh) to execute `markTaskDone` and update the active OpenSpec task list.
* **Non-Blocking Fault Tolerance**: If synchronization fails (e.g. because `tasks.md` was manually altered), the error is logged to `.sdlc/learnings/log.md` and flagged in the execution warnings summary, but the runner continues executing the remaining waves.

### 3. Commits (`/commit-sdlc`)
When committing changes:
* **Branch Matching**: [commit-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/commit-sdlc/SKILL.md) reads the current branch name and matches it against active OpenSpec changes by lowercased, slugified name.
* **Trailer Insertion**: If matched, it automatically appends an `OpenSpec-Change: <change-name>` trailer to the commit message, linking code changes directly to the specification history.

### 4. Shipping & Archival (`/ship-sdlc`)
The shipping pipeline integrates a dedicated `archive-openspec` step between the `version` and `pr` steps:
* **Strict Validation**: The pipeline invokes [openspec_validate.sh](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/ship-sdlc/scripts/openspec_validate.sh) which runs the CLI command `openspec validate <change-name> --strict` to verify task completion and schema validity.
* **Archive Execution**: If validation succeeds, [openspec_archive.sh](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/ship-sdlc/scripts/openspec_archive.sh) runs `openspec archive <change-name> --yes`. This moves the change folder to `openspec/changes/archive/`.
* **Archival Commit**: The pipeline stages the archived change directory and commits it:
  ```bash
  git add openspec/
  git commit -m "chore(openspec): archive <change-name>"
  ```

### 5. Setup & Onboarding (`/setup-sdlc`)
To ease developer onboarding, running `/setup-sdlc --openspec-enrich` (configured in [setup-openspec.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/setup-sdlc/resources/setup-openspec.md)) executes [openspec-enrich.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/util/openspec-enrich.js) to inject a managed documentation block into the top-level `openspec/config.yaml`:
```yaml
# BEGIN MANAGED BY sdlc-utilities (v2)
context: |
  SDLC workflow managed by sdlc-utilities. Do not edit this block manually.
  To update: /setup-sdlc --openspec-enrich. To remove: /setup-sdlc --remove-openspec.

  Contributor workflow:
    1. /plan-sdlc --from-openspec <change-name>  — create an implementation plan from the change
    2. /execute-plan-sdlc                         — execute the plan in waves
    3. /ship-sdlc                                 — commit, review, version, and open a PR

  Do not invoke `openspec archive` directly — /ship-sdlc handles archival
  as a conditional pipeline step after validation passes.
# END MANAGED BY sdlc-utilities (v2)
```

---

## Related Issues & References

* **#414**: Implementation of OpenSpec task-flip mapping, `markTaskDone` utility, and non-blocking sync warnings.
* **#417**: G17 dimension coverage integration with OpenSpec requirements.
* **#418**: Development of requirements lens reviewers checking OpenSpec task structures.
* **#351**: Root resolution enforcement ensuring that OpenSpec paths resolve correctly when working in Git worktrees.
