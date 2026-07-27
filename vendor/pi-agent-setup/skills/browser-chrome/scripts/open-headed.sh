#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

url="$(bc_headed_url)"
if bc_endpoint_ok "$url"; then
  printf 'OPEN mode=headed url=%s reused=1\n' "$url"
  exit 0
fi

if [ -n "${BROWSER_CHROME_HEADED_START_COMMAND:-}" ]; then
  # Remote/local custom start command. It is responsible for starting Chrome with a DevTools endpoint.
  bash -lc "$BROWSER_CHROME_HEADED_START_COMMAND"
  if bc_wait_endpoint "$url"; then
    printf 'OPEN mode=headed url=%s started=1 via=start-command\n' "$url"
    exit 0
  fi
  printf 'FAILED mode=headed url=%s reason=start-command-did-not-open-endpoint\n' "$url" >&2
  exit 1
fi

if [ "${BROWSER_CHROME_HEADED_LOCAL_START:-1}" = "0" ]; then
  printf 'FAILED mode=headed url=%s reason=endpoint-closed-and-local-start-disabled hint=start-chrome-or-ssh-tunnel\n' "$url" >&2
  exit 1
fi

profile_dir="$(bc_headed_user_data_dir)"
profile_directory="${1:-$(bc_headed_profile_directory)}"
port="$(bc_headed_port)"
bind_address="$(bc_headed_bind_address)"

if pgrep -af -- "--user-data-dir=$profile_dir" >/dev/null 2>&1; then
  printf 'FAILED mode=headed url=%s profile=%s reason=profile-process-running-but-endpoint-closed\n' "$url" "$profile_dir" >&2
  exit 1
fi

chrome="$(bc_chrome_bin)" || {
  echo "FAILED mode=headed reason=chrome-not-found set BROWSER_CHROME_BIN or BROWSER_CHROME_HEADED_START_COMMAND" >&2
  exit 1
}

mkdir -p "$profile_dir" "$(bc_home)/logs"
log_file="$(bc_home)/logs/headed.log"

"$chrome" \
  "--remote-debugging-address=$bind_address" \
  "--remote-debugging-port=$port" \
  "--user-data-dir=$profile_dir" \
  "--profile-directory=$profile_directory" \
  --no-first-run \
  --no-default-browser-check \
  --new-window \
  ${BROWSER_CHROME_HEADED_EXTRA_ARGS:-} \
  >>"$log_file" 2>&1 &

pid=$!
printf '%s\n' "$pid" >"$(bc_home)/headed.pid"

if bc_wait_endpoint "$url"; then
  printf 'OPEN mode=headed url=%s started=1 pid=%s profile=%s log=%s\n' "$url" "$pid" "$profile_dir" "$log_file"
  exit 0
fi

printf 'FAILED mode=headed url=%s pid=%s profile=%s log=%s reason=timeout\n' "$url" "$pid" "$profile_dir" "$log_file" >&2
exit 1
