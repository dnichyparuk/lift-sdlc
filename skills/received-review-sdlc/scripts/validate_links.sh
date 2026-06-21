#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

LINKS_LIB="$SDLC_ROOT/scripts/lib/links.js"
[ ! -f "$LINKS_LIB" ] && { echo "ERROR: Could not locate scripts/lib/links.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
printf '%s\n' "$reply_bodies_concatenated" | node "$LINKS_LIB" --json
LINK_EXIT=$?
