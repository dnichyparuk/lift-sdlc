#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

AR_SCRIPT="$SDLC_ROOT/scripts/skill/await-remote-review.js"
[ ! -f "$AR_SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/await-remote-review.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
   [ -z "$AR_SCRIPT" ] && [ -f "plugins/lift-sdlc/scripts/skill/await-remote-review.js" ] && AR_SCRIPT="plugins/lift-sdlc/scripts/skill/await-remote-review.js"
   [ -z "$AR_SCRIPT" ] && { echo "ERROR: Could not locate skill/await-remote-review.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
