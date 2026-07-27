#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

target="${1:-}"
state_dir="$(bc_headless_state_dir)"

close_one() {
  local state="$1"
  [ -f "$state" ] || return 0
  # shellcheck disable=SC1090
  source "$state"
  local id="${BROWSER_CHROME_ID:-unknown}"
  local pid="${BROWSER_CHROME_PID:-}"
  local profile="${BROWSER_CHROME_USER_DATA_DIR:-}"
  local close_command="${BROWSER_CHROME_CLOSE_COMMAND:-}"
  if [ -n "$close_command" ]; then
    BROWSER_CHROME_ID="$id" BROWSER_CHROME_DEBUG_URL="${BROWSER_CHROME_DEBUG_URL:-}" bash -lc "$close_command" >/dev/null 2>&1 || true
  fi
  if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" >/dev/null 2>&1 || break
      sleep 0.1
    done
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  [ -n "$profile" ] && rm -rf "$profile"
  rm -f "$state"
  printf 'CLOSED mode=headless id=%s\n' "$id"
}

case "$target" in
  "")
    echo "Usage: $0 <id|all|stale>" >&2
    exit 2
    ;;
  all)
    [ -d "$state_dir" ] || exit 0
    for state in "$state_dir"/*.env; do
      [ -e "$state" ] || continue
      close_one "$state"
    done
    ;;
  stale)
    [ -d "$state_dir" ] || exit 0
    for state in "$state_dir"/*.env; do
      [ -e "$state" ] || continue
      # shellcheck disable=SC1090
      source "$state"
      if [ -z "${BROWSER_CHROME_DEBUG_URL:-}" ] || ! bc_endpoint_ok "$BROWSER_CHROME_DEBUG_URL"; then
        close_one "$state"
      fi
    done
    ;;
  *)
    state="$state_dir/$target.env"
    if [ ! -f "$state" ]; then
      printf 'CLOSED mode=headless id=%s reason=no-state\n' "$target"
      exit 0
    fi
    close_one "$state"
    ;;
esac
