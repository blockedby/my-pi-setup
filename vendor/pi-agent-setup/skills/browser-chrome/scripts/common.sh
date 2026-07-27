#!/usr/bin/env bash
set -euo pipefail

bc_home() {
  printf '%s\n' "${BROWSER_CHROME_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/browser-chrome}"
}

bc_validate_headed_port() {
  local port="$1"
  case "$port" in
    ''|*[!0-9]*)
      printf 'FAILED mode=headed reason=invalid-headed-port port=%s hint=use-9200-9300\n' "$port" >&2
      return 1
      ;;
  esac
  if [ "$port" -lt 9200 ] || [ "$port" -gt 9300 ]; then
    printf 'FAILED mode=headed reason=invalid-headed-port port=%s hint=use-9200-9300\n' "$port" >&2
    return 1
  fi
}

bc_headed_port() {
  local port="${BROWSER_CHROME_HEADED_PORT:-9233}"
  bc_validate_headed_port "$port"
  printf '%s\n' "$port"
}

bc_headed_url() {
  if [ -n "${BROWSER_CHROME_HEADED_URL:-}" ]; then
    printf '%s\n' "$BROWSER_CHROME_HEADED_URL"
  else
    printf 'http://%s:%s\n' "${BROWSER_CHROME_HEADED_HOST:-127.0.0.1}" "$(bc_headed_port)"
  fi
}

bc_headed_bind_address() {
  printf '%s\n' "${BROWSER_CHROME_HEADED_BIND_ADDRESS:-127.0.0.1}"
}

bc_headed_user_data_dir() {
  printf '%s\n' "${BROWSER_CHROME_HEADED_USER_DATA_DIR:-$(bc_home)/headed-profile}"
}

bc_headed_profile_directory() {
  printf '%s\n' "${BROWSER_CHROME_HEADED_PROFILE_DIRECTORY:-Default}"
}

bc_headless_state_dir() {
  printf '%s\n' "$(bc_home)/headless"
}

bc_chrome_bin() {
  if [ -n "${BROWSER_CHROME_BIN:-}" ]; then
    printf '%s\n' "$BROWSER_CHROME_BIN"
    return 0
  fi
  local candidate
  for candidate in google-chrome-stable google-chrome chromium chromium-browser chrome; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

bc_curl() {
  curl --silent --show-error --fail --max-time "${BROWSER_CHROME_CURL_TIMEOUT:-2}" "$@"
}

bc_endpoint_ok() {
  local url="$1"
  bc_curl "$url/json/version" >/dev/null 2>&1
}

bc_wait_endpoint() {
  local url="$1"
  local timeout="${2:-${BROWSER_CHROME_START_TIMEOUT:-15}}"
  local start now
  start=$(date +%s)
  while true; do
    if bc_endpoint_ok "$url"; then
      return 0
    fi
    now=$(date +%s)
    if [ $((now - start)) -ge "$timeout" ]; then
      return 1
    fi
    sleep 0.25
  done
}

bc_pick_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

bc_id() {
  python3 - <<'PY'
import secrets, time
print(f"{int(time.time())}-{secrets.token_hex(4)}")
PY
}

bc_json_field() {
  local field="$1"
  python3 - "$field" <<'PY'
import json, sys
field = sys.argv[1]
data = json.load(sys.stdin)
value = data.get(field)
if value is None:
    sys.exit(1)
print(value)
PY
}

bc_script_dir() {
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd
}
