---
name: aad-task-package
description: Use when an AAD owner or delegated agent needs to create, locate, or update the repo-local task package that stores the plan, reports, verification evidence, and handoff artifacts for a task.
---

# AAD Task Package

## Overview

Use this skill whenever AAD work needs durable repo-local task documents.

A task package is the shared buffer between agents. It keeps the plan, delegated reports, verification evidence, blockers, follow-ups, and final status in one place.

Default location:

```text
.pi/aad/tasks/YYYY-MM-DD-<task-slug>/
```

Example:

```text
.pi/aad/tasks/2026-05-22-add-invoices-page/
```

## Directory structure

Use this structure unless the repo has a stricter convention:

```text
.pi/aad/tasks/YYYY-MM-DD-<task-slug>/
  README.md
  plan.md
  reports/
    explorer.md
    aad-implementer-<task-id>.md
    acceptance-auditor.md
    aad-failure-classifier-<failure-id>.md
    browser-<scope>.md
  verification/
    acceptance-plan.md
    local.md
    ci.md
    browser.md
    logs/
  artifacts/
    screenshots/
      <scope>/
        <run-id>/
          <viewport>-<section-or-scroll>.png
  progress/
    slice-owner.md
    aad-implementer-<task-id>.md
```

Add, rename, or omit files when the task shape demands it, but keep everything for the task under the task package directory.

## Task package creation

The first root or slice owner receiving an owned job checks for a supplied or repo-local task package before creating one. If `<task-package>/plan.md` exists, continue it. Create a task package only when no usable package and plan exist.

### Creation helper

Resolve [`scripts/create-task-package.sh`](scripts/create-task-package.sh) relative to the directory containing this `SKILL.md`. The helper creates the standard directories plus draft `README.md` and `plan.md` files. It refuses to overwrite an existing package.

Use the default `.pi/aad/tasks` location:

```bash
bash "<resolved-skill-directory>/scripts/create-task-package.sh" \
  --slug "<task-slug>" \
  --name "<task-name>"
```

Or choose another parent directory:

```bash
bash "<resolved-skill-directory>/scripts/create-task-package.sh" \
  --location "<task-package-parent>" \
  --slug "<task-slug>" \
  --name "<task-name>"
```

The resulting path is `<location>/YYYY-MM-DD-<task-slug>/`. `--name` is optional and defaults to a title derived from the slug. Use `--date YYYY-MM-DD` only when the package needs an explicit date instead of the current UTC date.

Creation checklist:

1. Search the delegated context and active worktree for the supplied or current task package.
2. If no plan exists, choose a short, stable lowercase kebab-case task slug and run the bundled creation helper, using `.pi/aad/tasks` unless the owner provides a repo-specific parent path.
3. Review and complete the generated `README.md`, which includes:
   - task name
   - status
   - owner / slice
   - branch / worktree
   - PR URL, if available
   - report index
4. Review and complete the generated `plan.md` with the active plan coordinator, current task intake, repo orientation, reuse discovery, missing pieces, plan tasks, dependency graph, agent order, and execution ledger.
5. Add task-specific files under the generated `reports/`, `verification/`, `artifacts/`, and `progress/` directories as needed.
6. Commit and push the initial task package when it uses an owner-provided tracked repository path and an early draft PR is being opened.

## Canonical plan coordination

For non-trivial delegated work, use `<task-package>/plan.md` as the one file-backed route ledger. The plan is entrypoint-independent: whichever root or slice owner creates a missing plan becomes its initial **active plan coordinator**. When a plan already exists, every later owner reads the recorded coordinator and continues the same plan instead of creating another one.

Only the active plan coordinator updates the canonical ledger. A coordination transfer must be recorded in the plan before a different owner edits it. Receiving the whole plan or one plan section for execution does not by itself transfer coordination.

Each child receives a distinct, file-backed report path and, for non-trivial work, a distinct progress path under the task package. A child may append dated status/comments only to its own supplied report/progress file; it must not edit the plan or another child file unless coordination was explicitly transferred. The active coordinator updates the ledger after reading those canonical child files. The default `.pi/` task package is ignored canonical AAD state and is not committed. Pi-subagents 0.34 still creates `.pi-subagents/` debug artifacts upstream; that compatibility path is also ignored and is not the canonical ledger. For trivial one-step work, omit the task package and return a concise inline result.

Before relying on harness inline output, a parent reads the child's routed report and progress files when provided. Inline output, transient run IDs, and temporary harness artifact paths are convenience signals, not the acceptance record.

If report validation fails, preserve the raw child report at its routed file and record a `report-invalid` status plus validation diagnostics in the ledger. Do not collapse useful findings into an opaque task failure. This is deliberately a narrow handling rule, not a versioned schema system.

## Plan as execution ledger

`plan.md` is not a write-once plan. Keep it current enough that another owner can continue without rediscovering task status.

Track:

- active plan coordinator and any coordination transfer
- task intake and assumptions
- repo orientation evidence
- reuse discovery
- missing pieces
- plan tasks and dependencies
- agent order: prerequisites, safe concurrency, plan context passed, return target, and current status
- assigned executors and report paths
- task status: pending / running / done / blocked / follow-up
- acceptance verification evidence
- blockers and side findings
- plan scorecard: completed tasks, satisfied acceptance criteria, passed evidence routes, resolved deviations, open blockers, and final plan result
- final done-state

Do not rewrite history-heavy details into prose. Prefer short, current status entries with links to the detailed report files.

## Report path routing

Every delegated prompt should include:

```text
Task name: <name>
Task package: <task-package>
Plan context: <whole plan / exact assigned sections plus referenced dependencies>
Agent order entry: <O1 / O2 / ...>
Report path: <task-package>/reports/<agent-or-task>.md
Verification path: <task-package>/verification/<file>.md, when relevant
```

If a report path is provided, write or update that file before returning. If no task package is provided for non-trivial routed work, create or infer the task package through this skill before delegation. For trivial work, return the report inline and say no task package was used.

## Agent report defaults

- `aad-explorer` → `reports/explorer/<explorer-task-slug>.md`
- `aad-slice-owner` progress → `progress/slice-owner.md`
- `aad-implementer` → `reports/implementer/<task-id>.md`
- `aad-implementer` progress → `progress/implementer/<task-id>.md`
- `aad-auditor` → `reports/auditor/<auditor-task-slug>`
- `aad-failure-classifier` → `reports/aad-failure-classifier-<failure-id>.md`
- `chrome-browser-agent` → `reports/browser-<scope>.md` or `verification/browser.md`; visual screenshots under `artifacts/screenshots/<scope>/<run-id>/<viewport>-<section-or-scroll>.png`
- `visual-critic` → `reports/visual-critic-<scope>.md` when delegated separately
- owner final report → `final-report.md` or the final section of `plan.md`

## Writing rules

- Task package writes are allowed even for otherwise read-only support agents, but only inside the provided task package path.
- Do not edit production code, tests, configs, or unrelated docs when acting as a read-only support agent.
- Use concise markdown with exact evidence: paths, commands, URLs, PR/check links, refs, and short output excerpts.
- Large logs may go under `verification/logs/`; summarize the relevant lines in markdown.
- Do not store secrets, tokens, cookies, private credentials, or sensitive local environment dumps.
- Prefer appending/updating the relevant report over scattering new files.
- Use `progress/` for internal agent progress notes; progress files are allowed to be rougher than final reports but must not contain secrets.
- If a file already contains another agent's report, append a timestamped section instead of overwriting it.

## Early draft PR convention

For implementation-bound root slice work:

1. Create/enter the worktree.
2. Create the task package and initial plan.
3. Commit and push the task package only when it uses an owner-provided tracked repository path.
4. Open a draft PR early, unless the user or repo policy says not to.
5. Continue dispatching agents and updating task package artifacts through the PR branch.

For sub-slices, follow parent/child worktree lineage rules: child task package artifacts belong to the child worktree while executing and must be integrated back into the parent slice package or linked from it during parent integration.

## Common mistakes

- treating the task package or plan as optional for owned execution
- creating a competing task package or plan when one already exists
- changing plan coordination without recording the transfer
- failing to update the plan after child results or execution deviations
- claiming done before the plan scorecard is complete
- writing only chat summaries when a task package path was provided
- creating reports outside the task package
- treating `plan.md` as stale after dispatch begins
- overwriting another agent's report
- putting secrets or noisy raw logs into committed docs
- opening implementation PRs without the plan package when the task is implementation-bound
