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

Event-keyed hook groups: `{ "<EventName>": [{ "matcher"?, "hooks": [{ "command": "node ./hooks/x.js" }] }] }`.
Observed events: `PreToolUse`, `PreInvocation`, `PostInvocation`, `Stop`. Hooks are plain Node
scripts, each with a `*.test.js` sibling in `lift-sdlc`'s convention.

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
| `$schema` | string | Optional | `https://antigravity.google/schemas/v1/plugin.json`, for editor validation |

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

### Documented gaps (confirmed absent from the official page, not merely unread)

The official docs do **not** specify, as of this fetch:
- `hooks.json` schema/structure
- `mcp_config.json` detailed format
- `agents/` directory specification (format of an Antigravity subagent file)
- `rules/` file format
- Valid model identifiers or a model-tier selection mechanism
- Any explicit statement of Claude Code plugin-format compatibility (or incompatibility)

---

## 3. Compatibility analysis

**What's confirmed compatible (safe to build on today):**
- The plugin-root marker file convention (`plugin.json`) is structurally the same idea in both —
  a small JSON manifest identifying the plugin.
- The skill-file convention is the same *shape*: one Markdown file, YAML/frontmatter `name` +
  `description`, body = instructions to the invoking LLM. A `SKILL.md` written with only `name`
  and `description` in its frontmatter (no Claude-specific extra fields) should parse under both
  systems' minimum requirements.

**What's confirmed to differ:**
- Directory location for skills: Claude Code plugins bundle `skills/*/SKILL.md` (one directory
  per skill) at the plugin root; Antigravity's documented workspace-skill location is
  `.agents/skills/` (flat `.md` files, not necessarily one-directory-per-skill) or a global path
  under `~/.gemini/`. A plugin intended for both should not assume the consuming host's directory
  convention — ship skills at the plugin-relative path documented for plugins in each host
  (`skills/` is listed as valid for an Antigravity plugin's own bundle, per §2's plugin layout).
- `plugin.json`'s validated field set: Antigravity's is minimal (`name` required, `description`
  optional, `$schema` optional); Claude Code plugins in this session's research always additionally
  carry `version` and `author`. Recommendation: keep both — Antigravity's docs don't say extra
  fields are rejected, and Claude Code plugins commonly rely on `version`.

**Genuinely unknown — do not assume, verify before depending on it:**
- Whether Antigravity's `agents/` subagent file format matches Claude Code's (`name`/`description`/
  `tools`/`model` frontmatter + role/Rules body) — undocumented on the official page fetched this
  session.
- Whether Antigravity's `hooks.json` uses the same event-keyed-array shape as Claude Code's.
- Model identifiers: Claude Code plugins name models by tier (`haiku`/`sonnet`/`opus`) or, when a
  plugin explicitly targets Antigravity (as `lift-sdlc` does — confirmed via its own model-tier
  strings being Gemini-specific, e.g. `gemini-3.8-flash-high/medium`), by a Gemini model string.
  Antigravity's own docs don't publish a canonical model-identifier list or tier-selection
  mechanism as of this fetch.

**Recommendation for `lift-fix-price`'s future skills/agents layer** (out of scope for the current
engine-foundation phase, but binding for whoever plans it next):
1. Keep `SKILL.md` frontmatter to the common subset (`name`, `description`) wherever possible;
   treat Claude-Code-only fields (`user-invocable`, `argument-hint`) as additive, not load-bearing.
2. Do not hardcode a Claude-specific model string (`sonnet`/`opus`) in frontmatter — use a
   config-driven model-tier abstraction (mirroring `lift-sdlc`'s own quality-tier indirection) so
   the same skill file resolves to the right model identifier under either host.
3. Before shipping `agents/*.md` or `hooks.json`, re-verify their Antigravity shape directly
   (the official docs had no schema for either as of this session) rather than assuming the
   Claude Code shape transfers unchanged.

---

## Sources

- Claude Code convention: direct inspection of `/mnt/c/projects-learn/lift-sdlc` and
  `/mnt/c/projects-learn/lift-rearch` (this session).
- [Plugins & Skills | Google Antigravity Docs](https://antigravity.google/docs/cli/plugins/) —
  fetched directly this session for the exact schema quoted in §2.
- [Authoring Google Antigravity Skills | Google Codelabs](https://codelabs.developers.google.com/getting-started-with-antigravity-skills)
- [Google Antigravity SDK | Google Antigravity Blog](https://antigravity.google/blog/introducing-google-antigravity-sdk)
