#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: create-task-package.sh --slug <slug> [options]

Create a dated AAD task package without overwriting an existing package.

Options:
  --slug <slug>          Required lowercase kebab-case task slug.
  --name <task-name>     Human-readable task name. Defaults to the slug in title case.
  --location <directory> Parent directory for task packages.
                         Default: .pi/aad/tasks
  --date <YYYY-MM-DD>    Package date. Defaults to the current UTC date.
  -h, --help             Show this help.
EOF
}

location=".pi/aad/tasks"
package_date="$(date -u +%F)"
slug=""
task_name=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug)
      [[ $# -ge 2 ]] || {
        usage
        exit 1
      }
      slug="$2"
      shift 2
      ;;
    --name)
      [[ $# -ge 2 ]] || {
        usage
        exit 1
      }
      task_name="$2"
      shift 2
      ;;
    --location)
      [[ $# -ge 2 ]] || {
        usage
        exit 1
      }
      location="$2"
      shift 2
      ;;
    --date)
      [[ $# -ge 2 ]] || {
        usage
        exit 1
      }
      package_date="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage
      exit 1
      ;;
  esac
done

[[ -n "$slug" ]] || {
  printf '%s\n' '--slug is required' >&2
  usage
  exit 1
}

[[ "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || {
  printf 'invalid slug %q: use lowercase kebab-case\n' "$slug" >&2
  exit 1
}

[[ "$package_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || {
  printf 'invalid date %q: expected YYYY-MM-DD\n' "$package_date" >&2
  exit 1
}

normalized_date="$(date -u -d "$package_date" +%F 2>/dev/null || true)"
[[ "$normalized_date" == "$package_date" ]] || {
  printf 'invalid calendar date: %s\n' "$package_date" >&2
  exit 1
}

location="${location%/}"
[[ -n "$location" ]] || {
  printf '%s\n' '--location must not be empty' >&2
  exit 1
}

if [[ -z "$task_name" ]]; then
  task_name="$(
    printf '%s\n' "$slug" |
      awk -F- '{
        for (i = 1; i <= NF; i++) {
          $i = toupper(substr($i, 1, 1)) substr($i, 2)
        }
        OFS = " "
        print $0
      }'
  )"
fi

[[ -n "$task_name" && "$task_name" != *$'\n'* && "$task_name" != *$'\r'* ]] || {
  printf '%s\n' '--name must be non-empty and on one line' >&2
  exit 1
}

package_dir="$location/$package_date-$slug"

if [[ -e "$package_dir" ]]; then
  printf 'task package already exists: %s\n' "$package_dir" >&2
  exit 2
fi

mkdir -p "$location"
staging_dir="$(mktemp -d "$location/.aad-task-package.XXXXXX")"
cleanup() {
  if [[ -n "${staging_dir:-}" && -d "$staging_dir" ]]; then
    rm -rf "$staging_dir"
  fi
}
trap cleanup EXIT

mkdir -p \
  "$staging_dir/reports" \
  "$staging_dir/verification/logs" \
  "$staging_dir/artifacts/screenshots" \
  "$staging_dir/progress"

cat > "$staging_dir/README.md" <<EOF
# $task_name

## Status

Draft

## Task package

- **Slug:** \`$slug\`
- **Created:** \`$package_date\`
- **Active plan coordinator:** Unassigned
- **Owner / slice:** Unassigned
- **Branch / worktree:** TBD
- **PR URL:** TBD

## Summary

TBD: Describe the task outcome and why the work is needed.

## Current state

- **Phase:** Planning
- **Next action:** Complete and approve the draft plan.
- **Blockers:** None recorded.

## Report index

- [Plan](plan.md)
- Reports: None yet.
- Verification evidence: None yet.
- Progress notes: None yet.
- Final report: Not available.
EOF

cat > "$staging_dir/plan.md" <<EOF
# $task_name — Draft Plan

## Plan status

- **Status:** Draft
- **Active plan coordinator:** Unassigned
- **Owner / slice:** Unassigned
- **Created:** \`$package_date\`
- **Last updated:** \`$package_date\`

## Task intake

### Request

TBD: Record the user's request and desired outcome.

### Scope

- **In scope:** TBD
- **Out of scope:** TBD
- **Assumptions:** TBD

### Acceptance criteria

- [ ] TBD: Add measurable acceptance criteria.

## Repository orientation

TBD: Record relevant entry points, existing conventions, tests, and constraints.

## Reuse discovery

TBD: Record existing components, scripts, utilities, or prior work that should be reused.

## Missing pieces

TBD: Record gaps between the current repository state and the requested outcome.

## Plan tasks

### T1 — Define the first implementation task

- **Status:** Pending
- **Owner:** Unassigned
- **Depends on:** None
- **Blocks:** TBD
- **Can run in parallel with:** TBD
- **Acceptance:** TBD
- **Report path:** TBD

## Dependency graph

TBD: Describe task dependencies and safe concurrency boundaries.

## Agent order

| Order | Task | Owner / executor | Depends on | Return target | Status |
| --- | --- | --- | --- | --- | --- |
| O1 | T1 | Unassigned | None | Active plan coordinator | Pending |

## Execution ledger

| Date | Task / event | Status | Evidence / report | Notes |
| --- | --- | --- | --- | --- |
| $package_date | Task package created | Done | [README](README.md) | Draft plan initialized. |

## Verification plan

- **Acceptance verification:** TBD
- **Local checks:** TBD
- **CI checks:** TBD
- **Browser / visual checks:** Not applicable unless required.

## Blockers and side findings

None recorded.

## Plan scorecard

- **Completed tasks:** 0 / 1
- **Satisfied acceptance criteria:** 0 / 1
- **Passed evidence routes:** 0
- **Resolved deviations:** 0
- **Open blockers:** 0
- **Plan result:** Not started

## Final done-state

Not started. Completion requires fresh acceptance evidence and an updated scorecard.
EOF

mv "$staging_dir" "$package_dir"
staging_dir=""
trap - EXIT

printf 'task_package=%s\n' "$package_dir"
printf 'readme=%s/README.md\n' "$package_dir"
printf 'plan=%s/plan.md\n' "$package_dir"
