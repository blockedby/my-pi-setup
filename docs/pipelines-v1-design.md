# Pipelines v1 — working design

_Status: collaborative notes. This file records only confirmed decisions. Open topics stay open; it is not an implementation contract._

## Confirmed starting constraints

- Pipelines are the intended user-facing orchestration feature; do not build a separate raw workflow surface for this proposal.
- v1 has one hardcoded **feature-pipeline** graph. Future versions may add other graphs for other task types.
- The main agent activates a pipeline through a first-class tool, analogous to how it uses `subagent_spawn`.
- `/pipelines` is a nested UI rather than a flat subagent-style list.
- Git/worktree policy is not hardcoded into the graph. The main agent chooses and prepares the working directory according to project instructions and applicable skills, then passes that workspace and delivery constraints to the pipeline. In the usual local flow this may be a dedicated branch/worktree with commits; other environments may require different behavior.
- Multiple pipeline runs may be active concurrently, including in the same working directory. v1 has no workspace-conflict gate; the invoking main agent and project policy own that decision. The UI must show each run's working directory clearly, while normal agent/model capacity limits still apply.
- Pipeline lifecycle matches current direct subagents: runs are session-scoped and in memory. On main-session shutdown/reload/switch/fork, the runtime disposes active pipeline-agent and child sessions; v1 does not resume them. Persisted child session files are diagnostic artifacts, not resumable pipeline state.
- One persistent **pipeline agent**, fixed to Sol in v1, owns orchestration, planning, implementation, and remediation. It receives pipeline-scoped child-management tools analogous to the main agent's subagent tools.
- The pipeline agent launches the four Discover Luna children, waits for and reads their reports, then plans and implements the feature itself.
- It launches the four parallel Audit Luna children, reads and resolves their reports, then launches one Terra final-audit child and resolves that report. Reports naturally return into the same pipeline-agent context as tool results.
- If a Discover or Audit child fails, the pipeline prompt tells the pipeline agent to retry that failed track at most once; after that it decides how to report or proceed within the final contract. This retry policy is prompt-controlled rather than a host scheduler rule; attempts remain visible in state/UI, and explicit user intervention may override it.
- There is no re-audit loop. The pipeline then hands the branch and reports back to the main agent for its decision.
- Pipeline child-management tools are scoped to the current run. They enforce allowed roles/models, record children and attempts under the run for nested UI, and are not available to Luna/Terra children. The host does not implement the graph or retry loop as a scheduler.
- `/pipelines` provides full control of the pipeline agent and its Luna/Terra children: nested transcript views, steer, and cancel. Pipeline children remain outside the flat `/subagents` projection.
- Parent/child session state, subscriptions, control actions, bounded transcripts, and takeover UI are implemented as reusable `extensions/shared/agent-tree` infrastructure. Pipeline graph semantics remain in `extensions/pipelines`. A later PR may migrate direct subagents to this shared tree and enable their second level; v1 does not enable recursive orchestration for ordinary subagents.

## Current discussion: Discover

The v1 pipeline is oriented around feature work. Discover is its first layer: four fixed Luna agents run in parallel and investigate these product questions at a high level:

1. **Problem:** which user problem or opportunity does the feature address?
2. **Outcome:** which new behavior or result should exist when it succeeds?
3. **Context:** what is the current user journey and which product or technical constraints matter?
4. **Evidence gaps:** what remains unknown before a solution can be selected?

Discover does not choose a solution or divide implementation work. Detailed prompts, output schemas, and failure behavior remain open.

## Audit tracks

The pipeline agent launches four fixed Luna feature-review tracks in parallel:

1. **Feature outcome / user scenarios:** whether the intended user value is present and key journeys work.
2. **Logic / invariants:** whether states, transitions, conditions, permissions, rules, and side effects are correct.
3. **Functional correctness:** whether observable behavior, contracts, integrations, edge cases, and data handling are correct.
4. **Reliability / regressions:** behavior under failures, retries, partial success, stale state, concurrency, and existing flows.

Each returns evidence to the pipeline agent; it does not issue the final pipeline decision.

## Current flow (confirmed only)

```text
Feature input
  → Persistent pipeline agent starts
      → Discover: pipeline agent manages four Luna children in parallel
      → Pipeline agent plans + implements
      → Audit: pipeline agent manages four Luna tracks in parallel
      → Pipeline agent resolves audit reports
      → Final audit: pipeline agent manages one Terra child
      → Pipeline agent resolves Terra report
  → Handoff: branch and reports return to main agent
```

## Runtime architecture

- `pipeline_run` starts the root Sol session in the caller-provided working directory, returns a run ID immediately, and delivers the eventual handoff to the main session as a follow-up.
- The Sol session receives normal coding tools plus run-scoped custom tools: stage marking, child spawn/list/check/wait/cancel, and completion.
- Child spawn accepts a hardcoded feature-pipeline role; the runtime selects the corresponding Luna or Terra model and role prompt. Child sessions do not receive orchestration tools.
- The prompt owns graph sequencing and the one-retry policy. The host owns session lifecycle, role/model boundaries, hierarchy, subscriptions, cancellation, model admission, and bounded state.
- Shared `agent-tree` infrastructure models root/children/attempts and supplies transcript, steer, cancel, and takeover behavior. Pipeline-specific graph/state and `/pipelines` composition stay in the pipelines extension.

## Completion handoff

`pipeline_complete` emits facts, not a readiness label. Its structured handoff includes the implemented outcome, changed paths, checks/evidence, commits or observed Git state when applicable, discovery/audit report references or summaries, unresolved items, and the working directory. The main agent alone decides readiness and subsequent Git/PR actions.

## Next discussion topic

Define the detailed prompts and structured report schemas while the runtime implementation proceeds.
