#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
NODE="${BROWSER_CHROME_NODE:-node}"

exec "$NODE" "$SKILL_DIR/control-mcp/server.mjs" --skill-dir "$SKILL_DIR" "$@"
