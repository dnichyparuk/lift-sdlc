#!/usr/bin/env bash
[ -z "$1" ] && { echo '{"status": "error", "error": "No PREPARE_OUTPUT_FILE provided."}' ; exit 2; }
F="$1" node -e "const d=require('fs').readFileSync(process.env.F,'utf8'); process.stdout.write(JSON.stringify({planFile: JSON.parse(d).context.planFile||''}))"
