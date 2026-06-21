#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# resolve_script is sourced once at Step 1; re-source here if running in a fresh shell block
VALIDATOR="$SDLC_ROOT/scripts/ci/validate-guardrails.js"
[ ! -f "$VALIDATOR" ] && { echo "ERROR: Could not locate scripts/ci/validate-guardrails.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }

node "$VALIDATOR" --project-root .
