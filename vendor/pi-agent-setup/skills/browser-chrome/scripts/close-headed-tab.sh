#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

target="${1:-}"
url="$(bc_headed_url)"
if [ -z "$target" ]; then
  echo "Usage: $0 <devtools-page-id|url-substring>" >&2
  exit 2
fi
if ! bc_endpoint_ok "$url"; then
  printf 'FAILED mode=headed url=%s reason=endpoint-closed\n' "$url" >&2
  exit 1
fi

pages_json="$(bc_curl "$url/json/list")"
page_id="$(PAGES_JSON="$pages_json" python3 - "$target" <<'PY'
import json, os, sys
needle = sys.argv[1]
pages = json.loads(os.environ['PAGES_JSON'])
for page in pages:
    if page.get('id') == needle:
        print(page['id'])
        raise SystemExit
for page in pages:
    if needle in page.get('url', '') or needle in page.get('title', ''):
        print(page['id'])
        raise SystemExit
raise SystemExit(1)
PY
)" || {
  printf 'FAILED mode=headed target=%s reason=page-not-found\n' "$target" >&2
  exit 1
}

bc_curl "$url/json/close/$page_id" >/dev/null
printf 'CLOSED mode=headed page=%s\n' "$page_id"
