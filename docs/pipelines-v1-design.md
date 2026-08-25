# Pipelines v1 — working design

_Status: collaborative notes. This file records only confirmed decisions. Open topics stay open; it is not an implementation contract._

## Confirmed starting constraints

- Pipelines are the intended user-facing orchestration feature; do not build a separate raw workflow surface for this proposal.
- v1 has one hardcoded **feature-pipeline** graph. Future versions may add other graphs for other task types.
- The main agent activates a pipeline through a first-class tool, analogous to how it uses `subagent_spawn`. It should do so automatically for a nontrivial new-feature implementation when the workspace is prepared; it should not route bugs, refactors, research-only work, or trivial edits into this v1 feature pipeline.
- `/pipelines` is a nested UI rather than a flat subagent-style list.
- Git/worktree policy is not hardcoded into the graph. The main agent chooses and prepares the working directory according to project instructions and applicable skills, then passes that workspace and delivery constraints to the pipeline. In the usual local flow this may be a dedicated branch/worktree with commits; other environments may require different behavior.
- Multiple pipeline runs may be active concurrently, including in the same working directory. v1 has no workspace-conflict gate; the invoking main agent and project policy own that decision. The UI must show each run's working directory clearly, while normal agent/model capacity limits still apply.
- Pipeline lifecycle matches current direct subagents: runs are session-scoped and in memory. On main-session shutdown/reload/switch/fork, the runtime disposes active pipeline-agent and child sessions; v1 does not resume them. Persisted child session files are diagnostic artifacts, not resumable pipeline state.
- One persistent **pipeline agent**, fixed to Sol with `high` reasoning in v1, owns orchestration, planning, implementation, and remediation. It receives pipeline-scoped child-management tools analogous to the main agent's subagent tools.
- The pipeline agent launches five Discover Luna children at `medium` reasoning, waits for and reads their reports, then plans and implements the feature itself.
- It launches the four parallel Audit Luna children at `medium` reasoning, reads and resolves their reports, then launches one Terra final-audit child at `high` reasoning and resolves that report. Reports naturally return into the same pipeline-agent context as tool results.
- If a Discover or Audit child fails, the pipeline prompt tells the pipeline agent to retry that failed track at most once; after that it decides how to report or proceed within the final contract. When a child session exists, retry uses a new turn in that same context, matching direct-subagent restart semantics; a pre-session spawn failure requires a new node. This retry policy is prompt-controlled rather than a host scheduler rule; attempts remain visible in state/UI, and explicit user intervention may override it.
- Terra's final audit is independent: it receives the feature task, acceptance/assumptions, current change, and checks, but not the earlier Luna audit reports or their resolutions. This reduces anchoring. There is no re-audit loop; after the pipeline agent resolves the Terra report, the pipeline hands the branch and reports back to the main agent for its decision.
- Pipeline child-management tools are scoped to the current run. They enforce allowed roles/models, record children and attempts under the run for nested UI, and are not available to Luna/Terra children. The host does not implement the graph or retry loop as a scheduler.
- `/pipelines` provides full control of the pipeline agent and its Luna/Terra children: nested transcript views, steer, and cancel. Stage rows/details show only status and nested agents/attempts; semantic reports remain in agent transcripts rather than being duplicated into the graph view. Pipeline children remain outside the flat `/subagents` projection.
- Parent/child session state, subscriptions, control actions, bounded transcripts, and takeover UI are implemented as reusable `extensions/shared/agent-tree` infrastructure. Pipeline graph semantics remain in `extensions/pipelines`. A later PR may migrate direct subagents to this shared tree and enable their second level; v1 does not enable recursive orchestration for ordinary subagents.

## Current discussion: Discover

The v1 pipeline is oriented around feature work. Discover is its first layer: five fixed Luna agents run in parallel and investigate these product questions at a high level:

1. **Problem:** identify the actor, their job, the current problem/opportunity, its consequence, and problem boundaries so the pipeline agent can formulate sound acceptance criteria; do not assess roadmap priority or invent ROI.
2. **Outcome:** identify observable desired outcomes and propose candidate acceptance criteria grounded in the task/product evidence. The pipeline agent owns the final feature contract.
3. **Context:** inspect the current user journey, neighboring scenarios, direct dependencies/contracts, and relevant repository conventions without broad architecture audit.
4. **User Scenarios:** map primary, alternative, empty/error/permission, and before/after journeys that the feature must handle.
5. **Product Precedents:** search the current product/repository first for similar behaviors, terminology, flows, tests, and interaction/implementation patterns that can keep the feature consistent. Use external research only when the task explicitly requires it.

The roles may repeat important facts; inexpensive redundancy is preferred over artificial non-overlap. Discover does not choose a solution or divide implementation work. All five roles return the same compact structured report: `summary`, `evidence`, `unknowns`, and `constraints`; each role prompt defines how those fields apply to its question. If the reports leave an important behavior choice ungrounded, the pipeline agent makes and records a reasonable assumption, continues implementation, and exposes that assumption in the final handoff rather than pausing for user input. Detailed wording remains open.

## Audit tracks

The pipeline agent launches four fixed Luna feature-review tracks in parallel:

1. **Feature outcome / user scenarios:** whether the intended user value is present and key journeys work.
2. **Logic / invariants:** whether states, transitions, conditions, permissions, rules, and side effects are correct.
3. **Functional correctness:** whether observable behavior, contracts, integrations, edge cases, and data handling are correct.
4. **Reliability / regressions:** behavior under failures, retries, partial success, stale state, concurrency, and existing flows.

Each returns evidence to the pipeline agent; it does not issue the final pipeline decision. All four use a shared finding contract derived from the canonical audit skill: concrete `scenario`, `expected`, `actual`, affected paths, relationship to the change, evidence type/evidence, impact, confidence, and minimal next action, plus exact unproven checks when necessary. They omit style/taste, generic hardening, unsupported speculation, impact-1 candidates, and confidence below 50. Missing tests are reported only when tied to a demonstrated behavior gap; Luna auditors do not emit READY/NOT_READY verdicts.

## Current flow (confirmed only)

```text
Feature input
  → Persistent pipeline agent starts
      → Discover: pipeline agent manages five Luna children in parallel
      → Pipeline agent plans + implements
      → Audit: pipeline agent manages four Luna tracks in parallel
      → Pipeline agent resolves audit reports
      → Final audit: pipeline agent manages one Terra child
      → Pipeline agent resolves Terra report
  → Handoff: branch and reports return to main agent
```

## Runtime architecture

- `pipeline_run` has a minimal v1 input: a self-contained `task` plus optional `working_dir` (defaulting to the caller's current directory). It starts the root Sol session there, returns a run ID immediately, and delivers the eventual handoff to the main session as a follow-up. Run title is derived from the task; delivery/Git constraints come from the task and loaded project resources rather than extra tool fields.
- The Sol session receives normal coding tools plus run-scoped custom tools: stage marking, child spawn/list/check/wait/cancel, and completion.
- Child spawn accepts a hardcoded feature-pipeline role; the runtime selects the corresponding Luna or Terra model and role prompt. Child sessions do not receive orchestration tools.
- The prompt owns graph sequencing and the one-retry policy. The host owns session lifecycle, role/model boundaries, hierarchy, subscriptions, cancellation, model admission, and bounded state.
- Shared `agent-tree` infrastructure models root/children/attempts and supplies transcript, steer, cancel, and takeover behavior. Pipeline-specific graph/state and `/pipelines` composition stay in the pipelines extension.

## Completion handoff

`pipeline_complete` emits facts, not a readiness label. Its structured handoff includes the implemented outcome, changed paths, checks/evidence, commits or observed Git state when applicable, discovery/audit report references or summaries, unresolved items, and the working directory. The main agent alone decides readiness and subsequent Git/PR actions.

## Next discussion topic

Define the detailed prompts and structured report schemas while the runtime implementation proceeds.
