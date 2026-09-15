# Plugin API Specs: Claude Code vs. Antigravity CLI

Reference for building the `lift-*` plugin family (`lift-fix-price`, `lift-sdlc`, `lift-rearch`)
so their skills/agents layers work identically under both Claude Code and Google's Antigravity
CLI. Compiled from direct inspection of `lift-sdlc`/`lift-rearch` (Claude Code convention,
observed in-repo) and Antigravity's official docs (fetched directly — see Sources). Where the
official Antigravity docs have a real gap, that gap is stated explicitly rather than guessed at.

---

## 1. Claude Code plugin format (observed convention)

Confirmed by direct inspection of `lift-sdlc` and `lift-rearch`, both real, working Claude Code
plugins.

### `plugin.json`

Minimal marker file at the plugin root:

```json
{
  "name": "lift-sdlc",
  "description": "Skills and commands for software development lifecycle workflows",
  "version": "0.21.0",
  "author": { "name": "dnichyparuk" }
}
```

No explicit skill/agent registry array — Claude Code auto-discovers:
- `skills/*/SKILL.md` → dispatched as `<plugin>:<skill-dir-name>`
- `agents/*.md` → dispatched as `<plugin>:<agent-file-name>`

### `skills/<name>/SKILL.md`

One Markdown file per skill, in its own directory (directory name is the skill's dispatch name).
Frontmatter fields observed: `name`, `description` (long, keyword-rich, often ends with
"Triggers on: ..."), `user-invocable: true`, `argument-hint`, `model` (a Claude Code model tier —
`haiku`/`sonnet`/`opus`, or in `lift-sdlc`'s case Gemini-tier strings, since that plugin targets
Antigravity specifically — see §3). Body is either prose steps or a literal numbered
Step-0..N workflow (lift-sdlc's convention) written as direct instructions to the invoking LLM.
Heavier skills reference a `references/*.md` or `resources/*.md` subfolder rather than inlining
everything.

### `agents/<name>.md`

Frontmatter: `name`, `description` (role summary), `tools` (explicit whitelist, e.g.
`Read, Glob, Grep, Write` — often narrowed, no `Bash`/`Edit`), `model`. Body: a short role
statement plus a bulleted "Rules" list. Agents are narrow-scope specialist workers dispatched
*from within* a skill (a sub-dispatch), distinct from a top-level skill invocation.

### `hooks.json` + `hooks/`

Named hook groups keyed by event, following the official Antigravity shape (see §2 item 5 for
the two array forms). Events in use: `PreToolUse`, `PreInvocation`, `PostInvocation`, `Stop`.
Hooks are plain Node scripts, each with a `*.test.js` sibling in `lift-sdlc`'s convention.

### Scripts convention (not a Claude Code requirement, but the `lift-*` house style)

`scripts/skill/*.js` (one "prepare" script per skill, does deterministic work, writes a JSON
manifest to a temp path, prints only the path to stdout) → skill dispatches a thin, read-only
orchestrator `Agent` that reads the manifest and returns a structured/string result → skill acts
on it. `scripts/lib/*.js` (shared pure logic), `scripts/util/*.js` (single-purpose helpers),
`scripts/ci/*.js` (repo-hygiene validators, e.g. checking every path a `SKILL.md` references
actually exists).

---

## 2. Antigravity CLI plugin format (official docs)

Source: `https://antigravity.google/docs/cli/plugins/` (fetched directly this session).

### Plugin directory layout

Plugins live under `~/.gemini/antigravity-cli/plugins/<plugin_name>/`:

**Required:** `plugin.json`
**Optional:** `mcp_config.json`, `hooks.json`, `skills/`, `agents/`, `rules/`

### `plugin.json` schema

| Field | Type | Requirement | Purpose |
|---|---|---|---|
| `name` | string | **Required** | Machine-readable identifier, pattern `^[a-zA-Z0-9-_]+$` |
| `description` | string | Optional | Human-readable purpose |
| `$schema` | string | Optional | Listed by the docs "for editor validation", but the documented URL `https://antigravity.google/schemas/v1/plugin.json` returns 404 (checked 2026-09-15); `lift-sdlc` omits it |

Notably: **no `version` or `author` field is part of the documented schema.** The `lift-*`
plugins' `plugin.json` files (including `lift-fix-price`'s, written this session) include both —
almost certainly harmless as extra unvalidated fields, but not part of Antigravity's own schema.

### Skills format

Workspace-level skills live in `.agents/skills/` (project-local) or
`~/.gemini/antigravity-cli/skills/` (global) — **not** literally documented as living inside a
*plugin's* own `skills/` directory, though the plugin directory layout above lists `skills/` as
one of a plugin's optional contents, implying plugin-bundled skills also use this shape. Each
skill is a `.md` file with YAML frontmatter:

```yaml
---
name: skill-identifier
description: Brief capability summary
---
```

Followed by explicit agent instructions in the body. Skills auto-convert to slash commands
(e.g. `/skill-identifier`) — the same effective shape as a Claude Code `SKILL.md`'s `name` +
`description` frontmatter pair.

### Confirmed Antigravity Schemas and Conventions (verified via `agy plugin validate` & binary inspection)

1. **`agents/` directory specification:**
   Each agent is a `.md` file with YAML frontmatter:
   ```yaml
   ---
   name: my-orchestrator
   description: Brief role summary
   subagent: true
   tools: view_file, write_to_file, replace_file_content, find_by_name, grep_search, run_command, invoke_subagent
   model: gemini-3.8-flash-low
   ---
   ```
   Validated by `agy plugin validate <dir>` (reports `✔ agents: N processed`).

2. **Native Tool Names:**
   Antigravity uses snake_case native tools rather than Claude Code tools:
   - `view_file` (replaces `Read`)
   - `write_to_file` (replaces `Write`)
   - `replace_file_content` (replaces `Edit` — uses `StartLine`, `EndLine`, `TargetContent`, `ReplacementContent`)
   - `find_by_name` (replaces `Glob`)
   - `grep_search` (replaces `Grep`)
   - `run_command` (replaces `Bash`)
   - `invoke_subagent` (replaces `Agent tool` / `subagent_type`)
   - `ask_question` (replaces `AskUserQuestion`)
   - `search_web` (replaces `WebSearch`)
   - `read_url_content` (replaces `WebFetch`)
   - `TodoWrite` is NOT present in Antigravity; progress is tracked via stdout markers, chat status, and persistent state files.

3. **`invoke_subagent` schema:**
   ```json
   {
     "Subagents": [
       {
         "TypeName": "research",
         "Role": "Codebase Researcher",
         "Model": "flash",
         "Workspace": "inherit",
         "Prompt": "..."
       }
     ]
   }
   ```
   Built-in subagents: `self` and `research`. Custom agents declared in `agents/` are invoked by their `name`.

4. **`ask_question` schema:**
   ```json
   {
     "questions": [
       {
         "question": "Choose an option:",
         "options": ["Option A", "Option B"],
         "is_multi_select": false
       }
     ]
   }
   ```

5. **`hooks.json` schema** (source: `https://antigravity.google/docs/hooks`, fetched directly):
   Top level maps a hook-group name to an event map. Optional `"enabled": false` disables the
   group. Supported events (exact spelling): `PreToolUse`, `PostToolUse`, `PreInvocation`,
   `PostInvocation`, `Stop`. There is **no** `SessionStart` or `UserPromptSubmit` event.

   The array element shape differs by event:
   - `PreToolUse` / `PostToolUse` → `{ "matcher": "<regex>", "hooks": [ <handler>, ... ] }`
     wrapper objects. Matcher: `""`/`"*"` = all tools, `"run_command"` exact, `"a|b"` alternation,
     `"browser_.*"` regex.
   - `PreInvocation` / `PostInvocation` / `Stop` → handler objects **directly** in the array.
     The official text: "For `PreInvocation`, `PostInvocation`, and `Stop`, the structure is
     simpler (a list of handlers directly under the event key) and the matcher is ignored."

   Handler: `{ "type": "command" (optional, default), "command": "<shell>" (required),
   "timeout": <seconds> (optional, default 30) }`.

   ```json
   {
     "git-guard": {
       "PreToolUse": [
         { "matcher": "run_command", "hooks": [ { "type": "command", "command": "node ./hooks/pre-tool-git-guard.js" } ] }
       ]
     },
     "session-context": {
       "PreInvocation": [
         { "type": "command", "command": "node ./hooks/session-start.js" }
       ]
     }
   }
   ```

   **Pitfall (observed in CLI logs on 2026-09-09/10):** wrapping a non-tool event's handler in
   `{ "hooks": [...] }` makes the CLI reject the *entire* plugin hooks.json at load time
   (`hooks.go: Failed to parse hooks for plugin lift-sdlc: invalid hook "<group>": command hook
   must specify 'command'`), silently disabling every hook of the plugin — while
   `agy plugin validate` still prints `✔ hooks : N processed`. `npm run check:plugin` now
   asserts the correct shapes (`scripts/ci/validate-plugin-schema.js`).

   Stdin/stdout contracts (camelCase). Common stdin fields on every event: `conversationId`,
   `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`.
   - `PreToolUse` in: `{ toolCall: { name, args }, stepIdx, ... }`; out:
     `{ decision: "allow|deny|ask|force_ask|deny_unless_prior_grant", reason?, permissionOverrides? }`.
   - `PostToolUse` in: `{ stepIdx, error?, ... }`; out: `{}`.
   - `PreInvocation` in: `{ invocationNum, initialNumSteps, ... }`; out:
     `{ injectSteps: [ { toolCall } | { userMessage } | { ephemeralMessage } ] }`. Fires before
     **every** model invocation — gate on `invocationNum` for once-per-session behaviour.
   - `PostInvocation` in: same as PreInvocation; out: `{ injectSteps?, terminationBehavior?: "force_continue|terminate|" }`.
   - `Stop` in: `{ executionNum, terminationReason, error?, fullyIdle, ... }`; out:
     `{ decision: "continue" }` re-enters the loop; any other value lets the run stop.

   Undocumented: which shell runs `command`, the working directory for relative paths, env
   vars available to the hook process, and stderr/exit-code handling.

---

## 3. Compatibility analysis

**What's confirmed compatible (safe to build on today):**
- The plugin-root marker file convention (`plugin.json`) is structurally the same idea in both —
  a small JSON manifest identifying the plugin.
- The skill-file convention is the same *shape*: one Markdown file, YAML/frontmatter `name` +
  `description`, body = instructions to the invoking LLM. A `SKILL.md` written with only `name`
  and `description` in its frontmatter (no Claude-specific extra fields) should parse under both
  systems' minimum requirements.
- `skills/` at the plugin root is supported and discovered by both Claude Code and Antigravity.

**What's confirmed to differ:**
- **Tool APIs:** Claude Code tools (`AskUserQuestion`, `Agent`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `Bash`, `TodoWrite`) do not exist or differ from Antigravity native tools (`ask_question`, `invoke_subagent`, `replace_file_content`, `write_to_file`, `view_file`, `find_by_name`, `grep_search`, `run_command`).
- **Subagent Dispatch:** Antigravity dispatches subagents with `invoke_subagent` with structured `Subagents: [...]` array, whereas Claude Code uses `Agent` with `subagent_type`.
- **User Prompts:** Claude Code uses `AskUserQuestion(question: "...")`, while Antigravity uses `ask_question(questions: [{question, options, is_multi_select}])`.

**Recommendation for `lift-fix-price`'s future skills/agents layer** (out of scope for the current
engine-foundation phase, but binding for whoever plans it next):
1. Keep `SKILL.md` frontmatter to the common subset (`name`, `description`) wherever possible;
   treat Claude-Code-only fields (`user-invocable`, `argument-hint`) as additive, not load-bearing.
2. In all skill instructions and agent prompts, strictly reference Antigravity native tools (`ask_question`, `invoke_subagent`, `view_file`, `replace_file_content`, `write_to_file`, `find_by_name`, `grep_search`, `run_command`).
3. For subagent fan-outs, use `invoke_subagent` with `TypeName: "self"`, `TypeName: "research"`, or custom agents registered in `agents/*.md`.
4. Run `agy plugin validate <plugin-dir>` to ensure full schema compliance.

---

## Sources

- Claude Code convention: direct inspection of `/mnt/c/projects-learn/lift-sdlc` and
  `/mnt/c/projects-learn/lift-rearch` (this session).
- [Plugins & Skills | Google Antigravity Docs](https://antigravity.google/docs/cli/plugins/) —
  fetched directly this session for the exact schema quoted in §2.
- [Authoring Google Antigravity Skills | Google Codelabs](https://codelabs.developers.google.com/getting-started-with-antigravity-skills)
- [Google Antigravity SDK | Google Antigravity Blog](https://antigravity.google/blog/introducing-google-antigravity-sdk)
