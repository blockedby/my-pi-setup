# Pipi: an isolated Pi setup

Pipi installs the creator's Pi extensions, skills, workflows, GitHub Dark Default theme, and a pinned Pi runtime beside regular `pi`. It keeps its runtime, settings, and sessions under `~/.pipi` without replacing or modifying regular Pi. When the [official Herdr](https://github.com/herdrdev/herdr) CLI is available, the installer adds Herdr's official Pi integration and the launcher applies its scoped Pi process hint so branded Pipi panes remain visible in the Agents list.

Included resources:

- Codex, Claude, and Pi subagents, including Luna exploration and Terra audit profiles
- four built-in hardcoded pipelines: `small-feature-pipeline`, `feature-pipeline`, `plan-pipeline`, and the read-only Luna `audit-pipeline`, with bounded fixed orchestration and nested `/pipelines` control
- background terminals and workflows
- `fd` file discovery and `rg` content search
- summaries, Git/model status UI, ask-user, and copy-all tools
- the GitHub Dark Default theme
- deterministic Codex-backed search/fetch/task tools when sibling `../pi-codex` is present
- isolated MCP support through `pi-mcp-adapter` 2.15.0, matching the extension version observed in regular Pi
- the `browser-chrome` skill and control/headed/headless Chrome DevTools MCP servers from `pi-agent-setup`
- the canonical evidence-driven `code-review` skill from the pinned `gpt5.6-reviewer` submodule
- the canonical `plan-gh-backlog` skill and CLI from its pinned submodule

## Agents

| Agent/profile   | Short purpose                                                |
| --------------- | ------------------------------------------------------------ |
| Pi subagent     | General delegated Pi task                                    |
| `luna-explore`  | Read-only exploration with Luna at max reasoning             |
| `luna-worker`   | Scoped implementation and testing with Luna at max reasoning |
| `terra-audit`   | Prompt-guided read-only audit with Terra                     |
| Claude subagent | General delegated Claude task                                |
| Codex subagent  | General delegated Codex task                                 |

## Skills

| Skill                  | Short purpose                              |
| ---------------------- | ------------------------------------------ |
| `subagents`            | Delegate work to child models              |
| `background-terminals` | Run and monitor background commands        |
| `code-review`          | Evidence-driven initial and closure review |
| `browser-chrome`       | Select and control a safe Chrome mode      |
| `codex-tools`          | Search, fetch, patch, and Codex tasks      |
| `plan-gh-backlog`      | Validate, plan, and publish issue backlogs |

The code-review policy is loaded directly from the initialized `vendor/gpt5.6-reviewer/skills` submodule, while `plan-gh-backlog` is loaded from `vendor/plan-gh-backlog`. Each source is pinned by the parent repository, and no colliding host skill is kept. The installer validates both initialized sources but never fetches, advances, or globally installs their optional CLIs.

No extra web-search service key or environment file is required. Pipi does not copy regular Pi's secret-bearing MCP configuration. See [SETUP.md](SETUP.md) for installation, isolation, MCP setup, auth, and uninstall instructions.

## Pipelines

A pipeline keeps one big task from turning into one giant, opaque prompt. A persistent Luna or Sol drives a bounded hardcoded route while isolated Luna sessions explore, build, audit, or synthesize focused concerns.

Use `small-feature-pipeline` for a focused build → audit → fix cycle, `feature-pipeline` for broader work with parallel discovery and review, `plan-pipeline` when you need an audited plan instead of code, and `audit-pipeline` for a read-only initial or closure audit with no remediation. Open `/pipelines` for a compact live view: `Enter` expands a run or opens the agent handling a stage, and green/yellow/red status shows how it is going at a glance.

`pipeline_run` selects one of these four definitions. Omitting `pipeline` remains backward-compatible and starts `feature-pipeline`:

```json
{ "task": "Implement export support", "working_dir": "/repo/worktree" }
```

Select the bounded implementation pipeline for a clear, localized feature that benefits from one implementation/audit/fix cycle:

```json
{
  "pipeline": "small-feature-pipeline",
  "task": "Add a focused export option with tests",
  "working_dir": "/repo/worktree",
  "git_commit": true
}
```

Select the standalone read-only audit pipeline for routine repository review:

```json
{
  "pipeline": "audit-pipeline",
  "task": "Audit the export change against its acceptance contract",
  "working_dir": "/repo/worktree",
  "audit": {
    "mode": "initial",
    "acceptance_criteria": ["Exports are complete and backward-compatible"]
  }
}
```

Closure mode additionally requires bounded `prior_blockers` with closure conditions, a supplied `remediation_diff`, and `touched_invariants`. The schema accepts no shell commands or Git refs; the host captures repository identity and read-only Git evidence.

Select the planning-only pipeline explicitly when the desired artifact is an implementation plan rather than product code:

```json
{
  "pipeline": "plan-pipeline",
  "task": "Plan export support across UI, API, release, and tests",
  "working_dir": "/repo/worktree"
}
```

Unknown definition names are rejected; this is not a raw-workflow API. `/pipelines` always shows all four definitions and nests each session-scoped run beneath the selected definition, with transcript/takeover, steer, and cancel controls.

The main agent can use `pipeline_list({})` to list its session-scoped runs newest-first and `pipeline_check({ "id": "pipeline-1" })` for a synchronous, nonblocking snapshot of one run. Checks show bounded stage progress, status counts, every root/child attempt, active model-visible previews, and an open tool name without exposing prompts, thinking, tool data, raw report/completion collections, or session paths. Completed runs show only compact completion counts and an optional plan path. These tools are unavailable inside pipeline agents, direct subagents, and workflow children. They are for occasional inspection, not polling: completion still arrives automatically as a follow-up handoff, while full transcripts and controls remain in `/pipelines`.

Automatic routing uses `audit-pipeline` for routine repository initial or closure audits; direct `terra-audit` remains available only for explicit manual escalation. It uses `small-feature-pipeline` for bounded, well-specified implementation work that fits one Luna implementation, four parallel independent Luna audit tracks, and one same-session Luna remediation pass. Broader nontrivial feature work that needs discovery and multi-concern audit uses `feature-pipeline`. `plan-pipeline` is selected only when the requested deliverable is a durable audited plan, task breakdown, dependency waves, or test/release plan and the goal has a complexity signal: multiple frontend/backend/data/DevOps/runtime layers; migration, rollout, rollback, operational-readiness, or cross-team sequencing; or acceptance criteria, scope, and dependencies that require repository discovery. Explicit pipeline selection overrides automatic routing. Bug fixes, refactors, research-only work, and trivial edits do not use implementation/planning pipelines unless the requested outcome is explicitly a bounded audit; a small feature is bounded work that still benefits from independent audit, not a synonym for a trivial edit. The main agent asks when plan versus implementation is ambiguous.

Pipeline audits receive host-collected, bounded, read-only Git evidence rather than agent-facing Git mutation tools. The controller captures the workspace base at run start and resolves current head, branch/status, base ancestry, bounded base-to-head commits, committed diff, dirty HEAD-to-worktree diff, and combined base-to-worktree diff with argument-array Git commands. Each item explicitly reports available, truncated, or unavailable evidence. `feature-pipeline`, `plan-pipeline`, `audit-pipeline`, and `small-feature-pipeline` reuse this evidence where their audit tracks apply.

`git_commit` is optional and defaults to false. It is accepted only by `small-feature-pipeline`; true grants only the same persistent `implement-small-feature` Luna session permission to make ordinary commits in the supplied current branch. It never permits push, merge, rebase, reset/history rewriting, branch or worktree operations. The permission is authoritative and is never inferred from task prose; false leaves implementation changes uncommitted.

`feature-pipeline` creates its persistent Sol session without sending a model prompt, then the controller launches and validates the same five Luna discovery tracks programmatically. Those sessions are read-only by tool policy: they retain repository read/search and deterministic read-only web search/fetch where available, but receive no shell, mutation, delegation, MCP, background, interaction, or orchestration tools. Each role submits a strict `feature-discovery-v2` envelope through its session-bound `pipeline_discovery_submit` tool; the host records the payload during the turn, consumes it only after that same turn settles, and retains validated final-text JSON as a compatibility fallback. The tool is unavailable to every other pipeline session.

V2 reports contain role-fixed ordered coverage, specific typed evidence, candidate acceptance criteria, actionable unknowns with safe assumptions, and sourced constraints. Covered/partial findings and not-applicable findings require evidence; unknown coverage stays explicit. Outcome and user-scenario reports require at least two observable candidate criteria unless the whole role is not applicable. Collections are capped at 12 items, ordinary text fields at 2 KiB, and each report at 20 KiB UTF-8 (100 KiB maximum five-report fan-in). A rejected settled turn receives up to three corrections in that same concrete session without disturbing other tracks; rejection four fails the run and cancels remaining sessions. Provider failure or cancellation may fail immediately, while replacement remains limited to creation failure before a usable session exists. Only complete validated fan-in activates Sol at `build`, with parsed report objects and provenance supplied as untrusted evidence. The fixed graph, controller ownership, parallel fan-out, and direct-subagent capacity independence are unchanged.

`small-feature-pipeline` runs this fixed graph. Its Luna coordinator and all audit children are read-only; the persistent Luna implementer session owns both implementation and remediation. All four audits run in parallel, and there is no re-audit after Luna fixes:

```text
Persistent read-only Luna/medium root
  ├─ one persistent Luna/medium implementer
  ├─ four parallel read-only Luna/medium audit tracks
  ├─ the same implementer session fixes or resolves all findings
  └─ factual handoff (no readiness verdict)
```

`audit-pipeline` is fully controller-owned and read-only:

```text
Persistent deferred Luna/medium synthesis root
  ├─ four isolated Luna/medium audit tracks in parallel
  ├─ synthesis activates when the first valid report settles
  ├─ later reports queue while synthesis is busy and are delivered when it is idle
  └─ one validated factual structured audit handoff (no remediation/readiness/Git decision)
```

The incremental reducer validates and accepts every expected role exactly once, batches arrivals while synthesis is busy, never interrupts an active turn, and finalizes only after all four reports are integrated and a strict final report passes. Audit tracks and the persistent synthesizer submit complete strict reports through the bounded `pipeline_audit_submit` tool; validated final-text output remains a compatibility fallback. A malformed settled turn receives up to three same-session corrections, with a fourth failure cancelling the run; track budgets are independent and the synthesizer budget is cumulative across revisions. `pipeline_check` exposes only bounded counts, reducer busy/idle state, revision, and final-validation state—not prompts, raw reports, Git evidence, tool data, or session paths. Feature and plan final-audit phases instantiate this same internal segment; their Sol roots still own final resolution and completion.

`plan-pipeline` runs this fixed graph. Its root and children do not receive shell/edit/write or delegated patch/task tools; Sol writes only through a bounded `docs/plans/*.md` plan tool and receives bounded plan-validation and Git-status tools:

```text
Persistent Sol/high root
  ├─ five parallel Luna/medium discovery tracks
  ├─ Sol writes docs/plans/<name>.md (no product implementation)
  ├─ four parallel Luna/medium plan audits
  ├─ Sol remediates the plan once
  ├─ four read-only Luna/medium final-audit tracks
  ├─ one persistent Luna/medium incremental synthesizer
  └─ Sol resolves the synthesis once and returns a factual handoff
```

The Markdown artifact records goals/non-goals, evidence and assumptions, candidate acceptance criteria, layer-specific and cross-cutting tasks, stable task IDs and dependencies, implementation waves, test/release/operational checks, risks, rollout/rollback, and unresolved questions. Evidence-backed inapplicable frontend, backend, or DevOps layers are recorded as such instead of receiving invented tasks. The completion handoff identifies the selected definition, plan path, changed paths, checks, assumptions, report summaries, unresolved items, working directory, and Git observations; it does not issue a readiness verdict.

Limitations: pipeline runs are in-memory and session-scoped, are not resumed after shutdown/reload, and may share a working directory because Pipi does not enforce workspace isolation. The planning pipeline does not implement its plan, commit, push, deploy, or decide whether the plan is ready for execution.

Additional documentation:

- [Complete local setup record and pending steps](docs/pipi-setup-record.md)
- [Hardcoded pipelines design](docs/pipelines-v1-design.md)
- [Black-and-white subagent graph](docs/subagents-explained.html)
- [Original subagent design plan used as a reference](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/docs/design-plan.md)

![Pi setup interface](assets/pi-setup.jpeg)
