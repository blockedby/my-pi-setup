#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

mode="${1:-}"
shift || true

export CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS="${CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS:-1}"
NPX="${BROWSER_CHROME_NPX:-npx}"
MCP_PACKAGE="${BROWSER_CHROME_MCP_PACKAGE:-chrome-devtools-mcp@latest}"
COMMON_ARGS=("-y" "$MCP_PACKAGE" "--no-usage-statistics" "--no-performance-crux")

case "$mode" in
  headed)
    "$SCRIPT_DIR/open-headed.sh" >/dev/null
    url="$(bc_headed_url)"
    exec "$NPX" "${COMMON_ARGS[@]}" "--browser-url=$url" "$@"
    ;;
  headless)
    output="$($SCRIPT_DIR/open-headless.sh)"
    id="$(awk '{for(i=1;i<=NF;i++){if($i ~ /^id=/){sub(/^id=/,"",$i); print $i}}}' <<<"$output" | tail -n1)"
    url="$(awk '{for(i=1;i<=NF;i++){if($i ~ /^url=/){sub(/^url=/,"",$i); print $i}}}' <<<"$output" | tail -n1)"
    if [ -z "$id" ] || [ -z "$url" ]; then
      echo "FAILED mode=headless reason=could-not-parse-open-output output=$output" >&2
      exit 1
    fi
    cleanup() {
      "$SCRIPT_DIR/close-headless.sh" "$id" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT INT TERM
    "$NPX" "${COMMON_ARGS[@]}" "--browser-url=$url" "$@"
    status=$?
    exit "$status"
    ;;
  *)
    echo "Usage: $0 <headed|headless> [chrome-devtools-mcp args...]" >&2
    exit 2
    ;;
esac
