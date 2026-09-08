---
applyTo: "docs/**/*.md,skills/*/SKILL.md,skills/*/resources/*.md,agents/*.md"
---
# documentation-review — Review Instructions

Reviews docs/, SKILL.md, and agent orchestrator prompt files for accuracy — this repo's docs include executable instructions, not just prose

Default severity: low

## Checklist

- Any `.sh` script path referenced in a `SKILL.md` bash block or prose actually exists at that path (a stale reference to a deleted/renamed script silently breaks the skill at runtime)
- `node <script>.js` invocation examples in `SKILL.md`/resource files match the target script's actual CLI flags (`parseArgs` accepted flags) — an invented or renamed flag fails only when a user hits that code path
- Cross-references between skills (e.g. one `SKILL.md` invoking a script that lives under a different skill's `scripts/`/`util/` directory) point at the correct final path
- `agents/*.md` orchestrator prompts describe inputs/outputs that match what the dispatching skill actually passes and expects back
- Code examples and command snippets in `docs/*.md` are runnable as written, not pseudocode presented as a real command
- New or renamed scripts, flags, or config keys are reflected in the relevant `SKILL.md` and `docs/` files in the same change — not left for a follow-up
- No leftover references to removed conventions (e.g. a `bash <script>.sh` instruction for a script that has since been migrated to Node.js and deleted)

## Severity Guide

| Finding | Severity |
|---------|----------|
| `SKILL.md` bash block references a script path that no longer exists | high |
| Documented CLI flag doesn't match the target script's actual `parseArgs` | high |
| Orchestrator prompt (`agents/*.md`) describes an input/output shape the dispatcher no longer sends/expects | medium |
| Cross-skill script reference points at a stale/renamed path | medium |
| Non-runnable example command in `docs/*.md` | low |
| Prose drift (accurate but outdated wording) | info |
