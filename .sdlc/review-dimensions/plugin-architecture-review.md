---
name: plugin-architecture-review
description: "Reviews changes to hooks.json, hooks/*.js interceptors, plugin.json, and SKILL.md contracts — this repo IS an Antigravity plugin, and hook bugs are safety-critical"
triggers:
  - "hooks.json"
  - "hooks/**/*.js"
  - "plugin.json"
  - "skills/*/SKILL.md"
severity: medium
model: gemini-3.1-pro-high
---

# Plugin Architecture Review

This repository is itself an Antigravity plugin (`plugin.json`), and `hooks.json` registers
five `PreToolUse`/`PreInvocation` hook interceptors (`pre-tool-git-guard.js`,
`pre-tool-file-guard.js`, `pre-tool-validate.js`, `session-start.js`, `stop-state-save.js`).
Every user of this plugin runs these hooks on every matching tool call — a bug here is not a
local defect, it either silently fails to guard something it should, or blocks something it
shouldn't.

## Checklist

- [ ] A hook change (`hooks/*.js`) still returns the expected decision shape for its
      registered event (`PreToolUse`/`PreInvocation`) — a malformed return can be silently
      ignored by the host, which looks like the hook "passing" when it actually never ran
      its check
- [ ] `pre-tool-git-guard.js` and `pre-tool-file-guard.js` changes don't narrow their
      matcher/condition in a way that lets a previously-blocked destructive operation
      through (verify against what the hook was specifically added to prevent)
- [ ] A new or modified hook fails closed (blocks/warns) rather than fails open (silently
      allows) on an unexpected error inside the hook itself
- [ ] `hooks.json` matcher patterns are still scoped to the intended tool/event — an
      over-broad matcher fires (and costs latency) on unrelated tool calls; an over-narrow
      one silently stops guarding cases it used to cover
- [ ] `plugin.json` version/metadata changes are consistent with what actually changed (a
      version bump without a matching change, or a real change without a version bump)
- [ ] A `SKILL.md` change to its documented CLI contract (flags, invocation shape,
      frontmatter `argument-hint`) is a deliberate, considered change — this is the
      user-facing interface of the plugin, and an accidental flag rename breaks every
      existing user's muscle memory / saved commands
- [ ] `SKILL.md` frontmatter (`name`, `description`, `argument-hint`, `model`) stays
      internally consistent with the skill's actual behavior after the change

## Severity Guide

| Finding | Severity |
|---------|----------|
| Hook change lets a previously-blocked destructive git/file operation through | critical |
| Hook fails open (silently allows) on internal error instead of failing closed | high |
| Hook return shape no longer matches what the host expects (silently ignored) | high |
| `SKILL.md` CLI contract changed without updating callers/docs referencing it | medium |
| `hooks.json` matcher scope narrowed/broadened unintentionally | medium |
| `plugin.json` version/metadata inconsistent with the actual change | low |
