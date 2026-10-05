# Agent system

## Status and scope

This document describes the SOTA-only agent-system interface in this revision. It takes effect after installation/reload; older running sessions may still advertise retired pipelines and model-bound profiles. Source verification does not imply runtime rollout.

Check the installed tool schema and model registry before launching. Do not guess provider/model IDs or send unsupported profile names. If the approved interface is unavailable, report the gap and work directly or agree on a supported alternative; do not launch a retired pipeline as a fallback.

The [legacy pipeline design](pipelines-v1-design.md) and [subagent graph](subagents-explained.html) describe older implementation details. They do not override this approved new-launch guidance.

## Choosing how to work

Delegation is optional. The main agent may study, implement, and verify directly, delegate a coherent task, or choose a pipeline when useful. Respect explicit requests to work solo, use a particular model or harness, or avoid pipelines. Planning and auditing do not automatically require orchestration.

Avoid compulsory microtasks, pseudocode handoffs, or file-by-file ownership plans. Give workers meaningful outcomes and enough context to exercise judgment. Split ownership where concurrent edits would conflict; otherwise choose parallelism only when work is genuinely independent and the coordination cost is justified.

The main agent owns cross-cutting integration, acceptance against the user's requirements, and any separately authorized delivery.

## Roles and models

| Role        | Authority                                   | Default model |
| ----------- | ------------------------------------------- | ------------- |
| `explore`   | Read-only investigation and evidence        | GPT6 Luna     |
| `implement` | Scoped workspace changes and verification   | Sol6.1        |
| `review`    | Independent read-only review and validation | Sol6.1        |

Roles are independent from model selection. The orchestrating agent chooses Sol6.1 or Luna6 for each task and uses Astra rarely when justified. Explicit model and reasoning overrides are permitted; resolve supported identifiers from the registry. There is no Luna-first routing rule.

Pipeline launches accept `role_models` overrides, and running pipeline sessions can use `pipeline_model_select` to adapt their own model without losing context or changing role, tools or permissions. Supported choices are `openai-codex/gpt-6.1-sol`, `openai-codex/gpt-6-luna` and `openai-codex/gpt-6-astra`. Each switch requires a task-specific reason, is recorded in run evidence, and does not change global defaults. Direct subagents receive model selection at launch; they do not gain unrestricted mid-run quota changes.

A child needs a self-contained request: goal, relevant workspace and evidence, constraints, expected outcome, and acceptance checks. It cannot see the parent conversation, ask the user, or recursively orchestrate agents, workflows, or pipelines.

Explorers and reviewers must not edit, create, delete, rename, format, commit, or otherwise mutate files, configuration, Git, credentials, or external state. Verification commands must respect that read-only boundary. Tool availability does not grant mutation authority. Reviewers supply findings and evidence rather than repairing the implementation.

Implementers may make scoped workspace changes and run proportionate checks. Neither delegation nor pipeline use authorizes unrequested commits, pushes, merges, deployments, credential changes, or other external-state changes. Broader delivery remains a separately authorized main-agent action.

## Public pipelines

Only these two pipelines are approved for new public launches:

### `implementing-pipeline`

1. **Study:** gather the requirements, precedents, constraints, and verification expectations needed for implementation.
2. **Implement:** produce a coherent solution with proportionate checks.
3. **Independent audits:** four separate read-only reviewers evaluate the implementation and its evidence independently. Sol is the default; launch overrides and session-local model selection remain available.
4. **Repair:** return findings to the original implementation session, preserving its context rather than starting a replacement implementer.

The main agent integrates and accepts the result. An implementation report or audit result alone is not final acceptance.

Before launch, the main agent creates a dedicated linked Git worktree on its own branch, runs the target repository's declared dependency/bootstrap/build preparation, and passes the exact worktree root. Preparation is repository-specific and caller-owned; the controller must not create the workspace, install dependencies, build packages, or guess commands.

For this repository, preparation is:

```sh
bun run install:dependencies
bun run check
bun run format:check
```

### `audit-pipeline`

Run independent read-only audits and consolidate the evidence into a report. Auditing does not grant repair or delivery permission and is not mandatory for every review task.

For initial review, supply the requirements and reviewed identity. For closure, supply the original blockers and remediation evidence. Follow the canonical shared `code-review` skill's host-compatible review contract when applicable.

### Retired launches and concurrency

`feature-pipeline`, `plan-pipeline`, and `small-feature-pipeline` are disabled for new launches under the approved design, even when an older installation still advertises them. Historical records and compatibility code are not permission to start them.

Sol/Terra/Luna concurrency quotas apply only to direct subagents. Pipeline graphs predeclare roots and children; pipelines must not enforce, inherit, queue on, or otherwise account for direct-subagent capacity limits. Actual direct-launch limits remain the tool contract's responsibility, not a model-routing preference.

## Progress and evidence

Direct subagent results arrive automatically as follow-ups. Continue independent work after launching; if none remains, end the turn with the task pending. Inspect status once when useful, but do not sleep, block, or poll for completion. A passive truncation advisory is a reason to consider further investigation, not a requirement to delegate.

Use `/subagents` and `/pipelines` to inspect supported runs. Require changed paths, verification results, and unresolved risks in implementation handoffs; require actionable findings with evidence in review handoffs. The main agent checks acceptance and reports any remaining runtime or verification gap without claiming a rollout occurred.
