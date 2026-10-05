---
name: subagents
description: Use when the user asks to use subagents; choose a role and task-specific model for bounded delegation.
---

# Subagents

Delegation is optional. Respect requests to work solo or avoid pipelines; do not automatically route implementation, planning, or review into a pipeline. Keep cross-cutting integration and final acceptance with the main agent.

Each child is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot recursively orchestrate subagents, workflows, or pipelines. Supply a self-contained task with relevant paths, constraints, acceptance evidence, and the expected report.

## Roles and model choice

The approved role profiles are independent of model selection:

| Profile     | Scope                                       | Default model |
| ----------- | ------------------------------------------- | ------------- |
| `explore`   | Read-only investigation and evidence        | GPT6 Luna     |
| `implement` | Scoped changes and proportionate checks     | Sol6.1        |
| `review`    | Independent read-only review and validation | Sol6.1        |

The orchestrating agent chooses Sol6.1 or Luna6 per task and Astra rarely when justified. Explicit model and reasoning overrides are permitted; roles do not fix a model. Honor user-selected harnesses and models. Resolve actual provider/model IDs from the available model registry rather than guessing them from these display names.

There is no Luna-first rule and no mandatory microtask, pseudocode, or file-ownership decomposition. Delegate coherent outcomes. Split ownership only where parallel edits would otherwise conflict; parallel work should be genuinely independent and worth the coordination cost.

Explorers and reviewers must not mutate workspace files, configuration, Git, credentials, or external state, including through verification commands. Implementers may make scoped workspace changes and run checks, but must not perform unrequested Git delivery, deployment, credential changes, or other external-state changes. A role or pipeline launch is not delivery permission.

## Launch and manage

Use `subagent_spawn` with a complete `prompt`, a short `name`, a trusted `working_dir` when needed, and the selected role and model supported by the installed tool schema. For profile-free launches, select an explicit `harness`; use `pi` unless the user requests another available harness. Claude Code and Codex require their respective CLIs and authentication.

Inspect the installed schema before launching: older running sessions can advertise a previous interface. Compatibility aliases `luna-explore`, `luna-worker` and `sol-worker` resolve to the modern roles/defaults, not the old model versions. Do not silently fall back to retired pipeline launches. Pipeline sessions may select a model with `pipeline_model_select`; direct subagents use launch-time selection. See [agent system](../../docs/agent-system.md).

Results arrive automatically as follow-ups. Continue useful independent work after spawning; if none remains, end the turn with the overall task pending. Do not block, sleep, or poll for completion.

- `subagent_check({ id })` or `subagent_list()`: inspect once when status is useful.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

If a completed result reports truncation, decide whether further read-only exploration is useful; the passive advisory is not a delegation requirement.

Direct-subagent concurrency quotas apply only to direct launches. Pipeline graphs predeclare their roots and children and must not enforce, inherit, queue on, or account for those quotas. Consult the installed tool contract for current limits.

## Optional pipelines

Only `implementing-pipeline` and `audit-pipeline` are approved for new public launches:

- `implementing-pipeline`: study → implement → independent read-only audits → repair in the original implementation session.
- `audit-pipeline`: independent read-only audits with a consolidated evidence-based report.

`feature-pipeline`, `plan-pipeline`, and `small-feature-pipeline` are disabled for new launches under the approved design. Do not substitute one if the new implementation pipeline is unavailable. Use direct work or an agreed supported alternative instead.

Pipeline use never bypasses role boundaries, caller-owned workspace preparation, user intent, or main-agent acceptance. See [agent system](../../docs/agent-system.md) for preparation and review handoffs.
