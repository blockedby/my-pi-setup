# Pipi: an isolated Pi setup

Pipi installs the creator's Pi extensions, skills, workflows, GitHub Dark Default theme, and a pinned Pi runtime beside regular `pi`. It keeps its runtime, settings, and sessions under `~/.pipi` without replacing or modifying regular Pi. When the [official Herdr](https://github.com/herdrdev/herdr) CLI is available, the installer adds Herdr's official Pi integration and the launcher applies its scoped Pi process hint so branded Pipi panes remain visible in the Agents list.

Included resources:

- Codex, Claude, and Pi subagents, including Luna exploration and Terra audit profiles
- three built-in hardcoded pipelines: `small-feature-pipeline` for bounded Luna implementation/audit/remediation, `feature-pipeline` for broader implementation, and `plan-pipeline` for durable audited implementation plans, all with persistent Sol orchestration and nested `/pipelines` control
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

| Agent/profile    | Short purpose                              |
| ---------------- | ------------------------------------------ |
| Pi subagent      | General delegated Pi task                  |
| `luna-explore`   | Read-only exploration with Luna at max reasoning |
| `luna-worker`    | Scoped implementation and testing with Luna at max reasoning |
| `terra-audit`    | Prompt-guided read-only audit with Terra    |
| Claude subagent  | General delegated Claude task              |
| Codex subagent   | General delegated Codex task               |

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

Pipelines are fixed, bounded multi-agent recipes for work that benefits from staged implementation, review, or planning. A persistent Sol orchestrator advances each run through a predefined graph, launches Luna and Terra roles with limited permissions, validates their reports, and returns a factual handoff instead of letting agents invent their own workflow.

Pipi includes `small-feature-pipeline` for one focused Luna implementation → Terra audit → same-Luna fix cycle, `feature-pipeline` for broader work with parallel discovery and audits, and `plan-pipeline` for producing an audited implementation plan without changing product code. Open `/pipelines` to see their runs: summaries stay collapsed with green/yellow/red textual status, while `Enter` expands a run or opens the agent responsible for a stage.

`pipeline_run` selects one of these three definitions. Omitting `pipeline` remains backward-compatible and starts `feature-pipeline`:

```json
{ "task": "Implement export support", "working_dir": "/repo/worktree" }
```

Select the bounded implementation pipeline for a clear, localized feature that benefits from one implementation/audit/fix cycle:

```json
{
  "pipeline": "small-feature-pipeline",
  "task": "Add a focused export option with tests",
  "working_dir": "/repo/worktree"
}
```

Select the planning-only pipeline explicitly when the desired artifact is an implementation plan rather than product code:

```json
{
  "pipeline": "plan-pipeline",
  "task": "Plan export support across UI, API, release, and tests",
  "working_dir": "/repo/worktree"
}
```

Unknown definition names are rejected; this is not a raw-workflow API. `/pipelines` always shows all three definitions and nests each session-scoped run beneath the selected definition, with transcript/takeover, steer, and cancel controls.

Automatic routing uses `small-feature-pipeline` for bounded, well-specified implementation work that fits one Luna implementation, one independent Terra audit, and one same-session Luna remediation pass. Broader nontrivial feature work that needs discovery and multi-concern audit uses `feature-pipeline`. `plan-pipeline` is selected only when the requested deliverable is a durable audited plan, task breakdown, dependency waves, or test/release plan and the goal has a complexity signal: multiple frontend/backend/data/DevOps/runtime layers; migration, rollout, rollback, operational-readiness, or cross-team sequencing; or acceptance criteria, scope, and dependencies that require repository discovery. Explicit pipeline selection overrides automatic routing. Bugs, refactors, research-only work, and trivial edits use no pipeline; a small feature is bounded work that still benefits from independent audit, not a synonym for a trivial edit. The main agent asks when plan versus implementation is ambiguous.

Implementation pipeline audits receive host-collected, read-only Git evidence rather than agent-facing Git mutation tools. The controller captures the workspace base at run start. In `feature-pipeline`, every Luna audit receives the captured base and current status/diff, while Terra receives a fresh snapshot after Luna remediation without receiving prior Luna findings. This evidence also supports the bounded small-feature audit; untracked paths remain visible through status and can be inspected with read-only file tools.

`small-feature-pipeline` runs this fixed graph. Sol and Terra are read-only; the persistent Luna session owns both implementation and remediation. Terra runs once, and there is no re-audit after Luna fixes:

```text
Persistent Sol/high root
  ├─ one persistent Luna/medium implementer
  ├─ one independent read-only Terra/high auditor
  ├─ the same Luna session fixes or resolves Terra findings
  └─ factual handoff (no readiness verdict)
```

`plan-pipeline` runs this fixed graph. Its root and children do not receive shell/edit/write or delegated patch/task tools; Sol writes only through a bounded `docs/plans/*.md` plan tool and receives bounded plan-validation and Git-status tools:

```text
Persistent Sol/high root
  ├─ five parallel Luna/medium discovery tracks
  ├─ Sol writes docs/plans/<name>.md (no product implementation)
  ├─ four parallel Luna/medium plan audits
  ├─ Sol remediates the plan once
  ├─ one independent Terra/high final audit
  └─ Sol remediates once and returns a factual handoff
```

The Markdown artifact records goals/non-goals, evidence and assumptions, candidate acceptance criteria, layer-specific and cross-cutting tasks, stable task IDs and dependencies, implementation waves, test/release/operational checks, risks, rollout/rollback, and unresolved questions. Evidence-backed inapplicable frontend, backend, or DevOps layers are recorded as such instead of receiving invented tasks. The completion handoff identifies the selected definition, plan path, changed paths, checks, assumptions, report summaries, unresolved items, working directory, and Git observations; it does not issue a readiness verdict.

Limitations: pipeline runs are in-memory and session-scoped, are not resumed after shutdown/reload, and may share a working directory because Pipi does not enforce workspace isolation. The planning pipeline does not implement its plan, commit, push, deploy, or decide whether the plan is ready for execution.

Additional documentation:

- [Complete local setup record and pending steps](docs/pipi-setup-record.md)
- [Hardcoded pipelines design](docs/pipelines-v1-design.md)
- [Black-and-white subagent graph](docs/subagents-explained.html)
- [Original subagent design plan used as a reference](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/docs/design-plan.md)

![Pi setup interface](assets/pi-setup.jpeg)
