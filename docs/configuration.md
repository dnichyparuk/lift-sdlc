# Configuration

## Permissions

Lift-SDLC runs internal helper scripts — Node.js utilities under the plugin's root `scripts/` folder and POSIX shell wrappers under `skills/<skill>/scripts/` — for planning, validation, and telemetry. Each invocation is a terminal `command`, so by default Antigravity prompts before running them. You can pre-approve them by adding `command(...)` rules to your **Allow** list.

Antigravity evaluates every sensitive operation as an `action(target)` resource across three lists, in strict priority **Deny > Ask > Allow** (see the [official Permissions docs](https://antigravity.google/docs/permissions)). For `command(...)`, each whitespace-separated token is matched as an *anchored* regex and the rule matches by token **prefix**, so trailing arguments are covered automatically. On Windows, Antigravity normalizes paths before matching (drive letter stripped, `\` → `/`), so the forward-slash rules below work cross-platform.

> Scope the rules to the plugin's **install directory name** (`sdlc`, per the Installation steps in the [README](../README.md)) — that is the path that appears in the executed command, *not* the plugin's internal manifest name (`lift-sdlc`). Scoping to `sdlc` also avoids auto-approving unrelated plugins.

### Antigravity 2.0 (IDE)

The IDE manages permissions through its UI. Open **Settings → Global Permissions** (or a Project's **Permissions**) and add the entries that match where you installed the plugin to the **Allow** list:

```text
# Global install (~/.gemini/config/plugins/sdlc)
command(node .*/\.gemini/config/plugins/sdlc/.*)              # Node helper scripts
command(.*/\.gemini/config/plugins/sdlc/skills/.*/scripts/.*) # Shell wrapper scripts

# Workspace install (.agents/plugins/sdlc or _agents/plugins/sdlc)
command(node .*/[._]agents/plugins/sdlc/.*)
command(.*/[._]agents/plugins/sdlc/skills/.*/scripts/.*)
```

You can also simply click **Allow** on the first permission card for each script; Antigravity caches the grant for subsequent identical invocations.

### Antigravity CLI

If you drive Lift-SDLC through the Antigravity CLI instead of the IDE, place the same grants in the CLI settings file under `permissions.allow`. The plugin reads `plansDirectory` from `~/.gemini/antigravity-cli/settings.json`, which is the most likely location — verify the exact path/schema for your CLI version:

```json
{
  "permissions": {
    "allow": [
      "command(node .*/\\.gemini/config/plugins/sdlc/.*)",
      "command(.*/\\.gemini/config/plugins/sdlc/skills/.*/scripts/.*)"
    ]
  }
}
```

### Auto-approving Subagent Writes (Scratch Folder)

When executing tasks or using subagents from the Antigravity CLI, you may be frequently prompted to confirm file write operations (e.g., being asked to press `Ctrl+K`) for temporary scratch files. To bypass these prompts while still maintaining security for your main workspace, you can explicitly allow writes to the conversation-scoped `brain` directory where these scratch files reside.

To do this, ensure your global `"toolPermission"` is set to `"request-review"` (the default) and add the `write_to_file` rule for the `brain` directory to your `permissions.allow` list:

```json
{
  "toolPermission": "request-review",
  "permissions": {
    "allow": [
      "write_to_file(/home/<your-username>/.gemini/antigravity-ide/brain)",
      "command(node .*/\\.gemini/config/plugins/sdlc/.*)",
      "command(.*/\\.gemini/config/plugins/sdlc/skills/.*/scripts/.*)"
    ]
  }
}
```

> **Note:** If you prefer full automation and do not want to be prompted for *any* commands or file writes, you can change `"toolPermission"` to `"always-proceed"`, or launch the CLI with the `--dangerously-skip-permissions` flag. Use this with caution.

## Plans Directory

By default, when you run `/plan-sdlc` in Normal Mode (not in an active plan session), the plugin writes your generated implementation plans to your home directory under `~/.gemini/plans/`. Since this path is outside your project workspace, it will trigger a permission prompt in the Antigravity sandbox.

You can configure a custom location for your plans either globally or locally for a specific repository using the `plansDirectory` setting in `settings.json`.

### Global Configuration

To save plans to a custom directory for all projects, edit `~/.gemini/antigravity-cli/settings.json`:

```json
{
  "plansDirectory": "/absolute/path/to/your/global/plans"
}
```

### Project-Specific Configuration

To save plans to a folder within a specific project (such as inside the `.sdlc` folder), create or edit `<project-root>/.gemini/antigravity-cli/settings.json`. Relative paths configured here resolve from the project root:

```json
{
  "plansDirectory": ".sdlc/plans"
}
```

The plugin automatically creates the directory structure if it does not already exist.

## Review & Execution Configuration (`.sdlc/config.json`)

You can customize subagent defaults and review behavior on a per-workspace basis by creating or modifying `.sdlc/config.json` in your project root:

```json
{
  "review": {
    "subagent_model": "gemini-3.8-flash-medium"
  }
}
```

- **`review.subagent_model`**: Sets the default model for `/review-sdlc` subagents when a review dimension does not explicitly specify a `model:` override in its YAML frontmatter.
