#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/util/scaffold-ci.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/util/scaffold-ci.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
