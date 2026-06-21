#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/ship.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/ship.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }

<!-- Implements A8d. Fixes #371. Workspace mode is intentionally omitted from this example so it falls back to `ship.workspace` config via `mergeFlags`; literal `--workspace <value>` here would override user config. -->
PREPARE_OUTPUT_FILE=$(node "$SCRIPT" --output-file --has-plan --auto)
# --bump is forwarded only when the user passes it; ship-prepare resolves bump from
# config (version.preRelease) or default (patch) otherwise. Passing --bump here would
# unconditionally override config, preventing pre-release trains from working (#394).
# Workspace mode comes from `.sdlc/local.json` (`ship.workspace`) via config fallback.
# Only pass `--workspace`, `--branch`, or `--tree` to override for a single run.
# Example override: node "$SCRIPT" --output-file --has-plan --auto --tree
# Pipeline composition (which steps run) comes from config `ship.steps[]`. To override
# the resolved step list for a single run, pass `--steps <csv>` (e.g.
# `--steps execute,commit,pr`). To set the model tier forwarded to execute-plan-sdlc,
# pass `--quality <full|balanced|minimal>` — only forwarded when explicitly passed.
# Legacy `--preset` and `--skip` are hard-removed (#190) and produce errors.
# The config-level field is `steps[]` (top-level `schemaVersion: 4`); preset/skip are no longer persisted.
#
# Hook signal — R-implicit-resume (#359):
# If the session-start system-reminder contains a line matching
# `/^Active pipeline: ship-sdlc/`, ALSO append `--hook-active-pipeline` to the
# invocation above. The prepare script then inspects the ship state file for the
# current branch and, when found+fresh, sets flags.implicitResume=true AND
# flags.resume=true so subsequent steps treat this run as a resume without
# requiring the user to type --resume. When no state file is found, prepare
# emits errors[*].id === "implicitResumeNoState" (handled in Step 1e).
EXIT_CODE=$?
# manifest is removed even if any pipeline step errors out, an Agent dispatch
# replaced — the --init-config path exits before reaching 1c, so there is no
# overlap in runtime lifecycle between the two manifest variables.

echo "PREPARE_OUTPUT_FILE: $PREPARE_OUTPUT_FILE"
echo "STATUS: $EXIT_CODE"