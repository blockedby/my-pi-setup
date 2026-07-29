#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

mode="${1:-headed}"
case "$mode" in
  headed)
    url="$(bc_headed_url)"
    if bc_endpoint_ok "$url"; then
      printf 'OPEN mode=headed url=%s\n' "$url"
      exit 0
    fi
    printf 'CLOSED mode=headed url=%s\n' "$url"
    exit 1
    ;;
  headless)
    id="${2:-}"
    if [ -z "$id" ]; then
      dir="$(bc_headless_state_dir)"
      if [ ! -d "$dir" ] || ! ls "$dir"/*.env >/dev/null 2>&1; then
        printf 'CLOSED mode=headless\n'
        exit 1
      fi
      found=0
      for state in "$dir"/*.env; do
        # shellcheck disable=SC1090
        source "$state"
        if [ -n "${BROWSER_CHROME_DEBUG_URL:-}" ] && bc_endpoint_ok "$BROWSER_CHROME_DEBUG_URL"; then
          printf 'OPEN mode=headless id=%s url=%s state=%s\n' "${BROWSER_CHROME_ID:-unknown}" "$BROWSER_CHROME_DEBUG_URL" "$state"
          found=1
        fi
      done
      [ "$found" -eq 1 ] && exit 0 || exit 1
    fi
    state="$(bc_headless_state_dir)/$id.env"
    if [ ! -f "$state" ]; then
      printf 'CLOSED mode=headless id=%s reason=no-state\n' "$id"
      exit 1
    fi
    # shellcheck disable=SC1090
    source "$state"
    if bc_endpoint_ok "$BROWSER_CHROME_DEBUG_URL"; then
      printf 'OPEN mode=headless id=%s url=%s state=%s\n' "$BROWSER_CHROME_ID" "$BROWSER_CHROME_DEBUG_URL" "$state"
      exit 0
    fi
    printf 'CLOSED mode=headless id=%s url=%s\n' "$BROWSER_CHROME_ID" "$BROWSER_CHROME_DEBUG_URL"
    exit 1
    ;;
  *)
    echo "Usage: $0 [headed|headless [id]]" >&2
    exit 2
    ;;
esac
