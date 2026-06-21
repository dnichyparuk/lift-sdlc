#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/plan.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/plan.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
[ -z "$SCRIPT" ] && [ -f "plugins/lift-sdlc/scripts/skill/plan.js" ] && SCRIPT="plugins/lift-sdlc/scripts/skill/plan.js"
# writes planIntegrity marker consumed by stop-plan-integrity Stop hook (issue #285)
[ -n "$SCRIPT" ] && node "$SCRIPT" --mark critiqueRan 2>/dev/null || true
