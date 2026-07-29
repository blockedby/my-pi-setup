#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

state_dir="$(bc_headless_state_dir)"
mkdir -p "$state_dir"

if [ -n "${BROWSER_CHROME_HEADLESS_START_COMMAND:-}" ]; then
  output="$(bash -lc "$BROWSER_CHROME_HEADLESS_START_COMMAND")"
  id="$(awk '{for(i=1;i<=NF;i++){if($i ~ /^id=/){sub(/^id=/,"",$i); print $i}}}' <<<"$output" | tail -n1)"
  url="$(awk '{for(i=1;i<=NF;i++){if($i ~ /^url=/){sub(/^url=/,"",$i); print $i}}}' <<<"$output" | tail -n1)"
  id="${id:-$(bc_id)}"
  if [ -z "$url" ]; then
    printf 'FAILED mode=headless reason=start-command-did-not-print-url output=%s\n' "$output" >&2
    exit 1
  fi
  state_file="$state_dir/$id.env"
  cat >"$state_file" <<EOF
BROWSER_CHROME_ID='$id'
BROWSER_CHROME_MODE='headless'
BROWSER_CHROME_REMOTE='1'
BROWSER_CHROME_DEBUG_URL='$url'
BROWSER_CHROME_STATE_FILE='$state_file'
BROWSER_CHROME_CLOSE_COMMAND='${BROWSER_CHROME_HEADLESS_CLOSE_COMMAND:-}'
EOF
  if bc_wait_endpoint "$url"; then
    printf 'OPEN mode=headless id=%s url=%s state=%s remote=1\n' "$id" "$url" "$state_file"
    if [ "${1:-}" = "--print-env" ]; then
      cat "$state_file"
    fi
    exit 0
  fi
  printf 'FAILED mode=headless id=%s url=%s reason=start-command-endpoint-unreachable\n' "$id" "$url" >&2
  exit 1
fi

if [ "${BROWSER_CHROME_HEADLESS_LOCAL_START:-1}" = "0" ]; then
  echo "FAILED mode=headless reason=endpoint-closed-and-local-start-disabled set BROWSER_CHROME_HEADLESS_START_COMMAND" >&2
  exit 1
fi

chrome="$(bc_chrome_bin)" || {
  echo "FAILED mode=headless reason=chrome-not-found set BROWSER_CHROME_BIN or BROWSER_CHROME_HEADLESS_START_COMMAND" >&2
  exit 1
}

id="$(bc_id)"
port="$(bc_pick_port)"
url="http://127.0.0.1:$port"
profile_dir="$state_dir/$id-profile"
log_dir="$(bc_home)/logs"
log_file="$log_dir/headless-$id.log"
state_file="$state_dir/$id.env"

mkdir -p "$profile_dir" "$state_dir" "$log_dir"

"$chrome" \
  --headless=new \
  --disable-gpu \
  --hide-scrollbars \
  --mute-audio \
  "--remote-debugging-address=127.0.0.1" \
  "--remote-debugging-port=$port" \
  "--user-data-dir=$profile_dir" \
  --no-first-run \
  --no-default-browser-check \
  ${BROWSER_CHROME_HEADLESS_EXTRA_ARGS:-} \
  >>"$log_file" 2>&1 &

pid=$!
cat >"$state_file" <<EOF
BROWSER_CHROME_ID='$id'
BROWSER_CHROME_MODE='headless'
BROWSER_CHROME_PID='$pid'
BROWSER_CHROME_PORT='$port'
BROWSER_CHROME_DEBUG_URL='$url'
BROWSER_CHROME_USER_DATA_DIR='$profile_dir'
BROWSER_CHROME_LOG_FILE='$log_file'
BROWSER_CHROME_STATE_FILE='$state_file'
EOF

if bc_wait_endpoint "$url"; then
  printf 'OPEN mode=headless id=%s url=%s pid=%s profile=%s state=%s log=%s\n' "$id" "$url" "$pid" "$profile_dir" "$state_file" "$log_file"
  if [ "${1:-}" = "--print-env" ]; then
    cat "$state_file"
  fi
  exit 0
fi

kill "$pid" >/dev/null 2>&1 || true
rm -rf "$profile_dir" "$state_file"
printf 'FAILED mode=headless id=%s url=%s pid=%s log=%s reason=timeout\n' "$id" "$url" "$pid" "$log_file" >&2
exit 1
