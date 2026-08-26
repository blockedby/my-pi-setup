# Hardcoded pipelines — design and runtime contract

_Status: implemented design record. Historical feature-pipeline v1 decisions remain below; the small-feature-pipeline and plan-pipeline additions are specified in their own sections._

## Confirmed starting constraints

- Pipelines are the intended user-facing orchestration feature; do not build a separate raw workflow surface for this proposal.
- The package has three hardcoded definitions: **feature-pipeline**, **small-feature-pipeline**, and **plan-pipeline**. The public selector accepts only these known definitions; it does not expose arbitrary workflows.
- The main agent activates a pipeline through a first-class tool, analogous to how it uses `subagent_spawn`. It should do so automatically for a nontrivial new-feature implementation when the workspace is prepared; it should not route bugs, refactors, research-only work, or trivial edits into this v1 feature pipeline.
- `/pipelines` is a nested UI rather than a flat subagent-style list. It always lists all hardcoded definitions and nests each run beneath its selected definition.
- Git/worktree policy is not hardcoded into the graph. The main agent chooses and prepares the working directory according to project instructions and applicable skills, then passes that workspace to the pipeline; delivery constraints come from the self-contained task and loaded project resources. In the usual local flow this may be a dedicated branch/worktree with commits; other environments may require different behavior.
- Multiple pipeline runs may be active concurrently, including in the same working directory. v1 has no workspace-conflict gate; the invoking main agent and project policy own that decision. The UI must show each run's working directory clearly. Pipeline sessions use their own Sol=4, Terra=8, and Luna=16 capacity pools, intentionally independent from direct `/subagents` capacity.
- Pipeline lifecycle matches current direct subagents: runs are session-scoped and in memory. On main-session shutdown/reload/switch/fork, the runtime disposes active pipeline-agent and child sessions; v1 does not resume them. Persisted child session files are diagnostic artifacts, not resumable pipeline state.
- One persistent **pipeline agent** owns each definition's orchestration and receives pipeline-scoped child-management tools analogous to the main agent's subagent tools. Feature and plan roots use Sol/high; the routing-only small-feature root uses Luna/medium.
- The pipeline agent launches five Discover Luna children at `medium` reasoning, waits for and reads their reports, then plans and implements the feature itself.
- It launches the four parallel Audit Luna children at `medium` reasoning, reads and resolves their reports, then launches one Terra final-audit child at `high` reasoning and resolves that report. Reports naturally return into the same pipeline-agent context as tool results.
- If a Discover or Audit child fails, the pipeline prompt tells the pipeline agent to retry that failed track at most once; after that it decides how to report or proceed within the final contract. When a child session exists, retry uses a new turn in that same context, matching direct-subagent restart semantics; a pre-session spawn failure requires a new node. This retry policy is prompt-controlled rather than a host scheduler rule; attempts remain visible in state/UI, and explicit user intervention may override it.
- Terra's final audit is independent: it receives the feature task, acceptance/assumptions, current change, and checks, but not the earlier Luna audit reports or their resolutions. This reduces anchoring. There is no re-audit loop; after the pipeline agent resolves the Terra report, the pipeline hands the branch and reports back to the main agent for its decision.
- Pipeline child-management tools are scoped to the current run. They enforce allowed roles/models, record children and attempts under the run for nested UI, and are not available to Luna/Terra children. The host does not schedule graph tool calls or retries. A successful `pipeline_child_wait` over a current-stage child atomically advances `discover → build`, `audit → audit-resolve`, or `final-audit → final-resolve` only after every required role for that fan-in has a successful report accepted by that pipeline definition's validator; this keeps authoritative `run.stage` aligned while the persistent root processes the returned reports.
- `/pipelines` provides full control of the pipeline agent and its Luna/Terra children: nested transcript views, steer, and cancel. Stage rows/details show only status and nested agents/attempts; semantic reports remain in agent transcripts rather than being duplicated into the graph view. The orange running glyph belongs to the active stage rather than the persistent root, while child attempts retain their own result glyphs. Pipeline children remain outside the flat `/subagents` projection.
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

The host captures `HEAD` when the feature run starts. At each Luna audit spawn it supplies that stable base, `WORKTREE` review-head label, current short Git status, and a bounded base-relative diff in addition to Sol's feature contract/check context. At final Terra spawn the host collects the evidence again, after Luna remediation, so Terra reviews the current change independently without receiving prior Luna reports. These are internal read-only commands invoked without shell interpolation; no agent receives a new Git mutation tool. A non-Git workspace degrades to explicit unavailable evidence, and status plus normal read-only file tools cover reported untracked paths.

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

- `pipeline_run` accepts a self-contained `task`, optional `working_dir` (defaulting to the caller's current directory), and optional enum-like `pipeline`. Omission defaults to `feature-pipeline`; unknown definitions are rejected. It starts the definition-selected persistent root session there, returns a run ID immediately, and delivers the eventual handoff to the main session as a follow-up. Run title is derived from the task; delivery/Git constraints come from the task and loaded project resources rather than extra tool fields.
- The persistent root receives run-scoped custom tools for stage marking, child spawn/list/check/wait/send/cancel, and completion. Tool mutation boundaries are definition-specific: the full feature Sol may implement, while the small-feature Luna and planning Sol roots are read-only.
- Child spawn accepts only roles hardcoded for the selected definition; the runtime selects the corresponding Luna or Terra model, role prompt, persistence, and tool policy. Child sessions do not receive orchestration tools.
- The prompt owns graph sequencing and the one-retry policy. The host owns session lifecycle, role/model boundaries, hierarchy, subscriptions, cancellation, model admission, and bounded state.
- Shared `agent-tree` infrastructure models root/children/attempts and supplies transcript, steer, cancel, and takeover behavior. Pipeline-specific graph/state and `/pipelines` composition stay in the pipelines extension.

## Completion handoff

`pipeline_complete` emits facts, not a readiness label. Its structured handoff includes the selected definition, outcome, changed paths, checks/evidence, commits or observed Git state when applicable, discovery/audit report references or summaries, unresolved items, and the working directory. A completed `plan-pipeline` run additionally requires a validated repository-local `docs/plans/*.md` plan path. The main agent alone decides readiness and subsequent Git/PR actions.

## Small-feature-pipeline definition

`small-feature-pipeline` is for bounded, well-specified implementation work that still benefits from independent multi-concern audit. Its persistent Luna/medium root is a read-only orchestrator rather than an implementer. A separate persistent Luna/medium session owns the initial implementation and the only remediation pass; the shared `PIPELINE_4_LUNA_AUDIT_ROLES` contract supplies four independent read-only Luna/medium audit tracks.

```text
Task
  → Persistent read-only Luna/medium root
      → one persistent Luna/medium implementer
      → four parallel read-only Luna/medium audit tracks
      → the same implementer session receives all reports and remediates once
  → Factual handoff; no re-audit and no readiness verdict
```

The run starts at `build`, advances to `final-audit` only after an exact implementation report, advances to `final-resolve` only after all four Luna audit reports pass the shared track/findings/unproven-checks contract, and advances to `complete` only after the original implementer session returns a fresh post-remediation report. The host rejects duplicate child roles, audit continuation, partial fan-in, out-of-order stages, malformed child reports, completion before remediation, and mutation tools for the Luna root or audit children. The implementer receives bounded workspace coding tools but no orchestration, delegated Codex task/patch, background-terminal, or generic MCP tools and must not commit or push.

The implementation report records a non-empty summary plus changed paths, checks, assumptions, and unresolved items. The host captures the workspace base identity when the run starts and supplies each audit track with that base, current Git status/diff, the original task, and the implementation report. Each auditor can inspect reported or untracked paths with read-only tools. The Luna root sends all four reports to the same implementer session whether or not they contain findings, so the bounded graph and same-session invariant remain observable. There is no discovery fan-out, root implementation, Terra audit, retry/replacement, or audit after remediation.

## Plan-pipeline definition

`plan-pipeline` is planning-only. Its persistent Sol/high root may inspect the repository, write and remediate one Markdown plan under `docs/plans/`, and run read-only validation. Plan roots and children are denied shell/edit/write, delegated patch/task, and background-shell mutation tools. Sol writes only through a bounded plan-artifact tool and uses bounded plan-validation and Git-status tools. It must not implement the requested product goal, modify product code, commit, push, install runtime changes, or deploy.

```text
Goal
  → Persistent Sol/high root
      → Discover (one parallel wave, Luna/medium)
          ├─ goal/outcomes and candidate acceptance criteria
          ├─ frontend/UI scope
          ├─ backend/data/API scope
          ├─ DevOps/runtime/release scope
          └─ testing/quality strategy
      → Sol synthesizes docs/plans/<descriptive-name>.md
      → Audit (one parallel wave, Luna/medium)
          ├─ product outcome and AC traceability
          ├─ decomposition, dependencies, and DAG quality
          ├─ cross-layer integration
          └─ test, release, and reliability coverage
      → Sol resolves actionable Luna findings once
      → Independent Terra/high final audit
      → Sol resolves Terra findings once; no re-audit
  → Factual plan handoff
```

All children are fixed direct children of the root and receive no orchestration tools, so there are no grandchildren. The controller enforces stage order, definition-specific roles, one valid report per required track before phase transitions/completion, at most one same-session retry for a failed or malformed discovery/Luna audit report, and no Terra retry. A pre-session discovery/Luna spawn failure may create one replacement attempt. A track may explicitly report `not applicable` when supported by repository evidence.

### Plan artifact contract

The artifact has a level-one title and level-two sections for:

- goal and non-goals;
- repository evidence and explicit assumptions;
- candidate acceptance criteria;
- frontend, backend, DevOps, and cross-cutting tasks;
- a test plan addressing unit, integration, contract, e2e, and operational checks, including evidence-backed `not applicable` entries;
- dependency-safe implementation waves;
- risks, rollout, and rollback;
- unresolved questions.

Implementation tasks use unique stable IDs such as `TASK-001`. Every task records scope, likely paths/components, dependencies, and acceptance/verification evidence, and every task appears in an implementation wave. Frontend/backend/DevOps sections remain present but may state that the layer is not applicable rather than inventing tasks.

The controller validates the completed plan's repository-local path and structural contract. Plan discovery reports use the established `summary`/`evidence`/`unknowns`/`constraints` object. Luna audits use `track`/`findings`/`unprovenChecks`. Contract warnings are returned to Sol so a failed or malformed Luna track can receive its one bounded retry. Terra follows the canonical code-review skill in initial mode, adapted to concrete plan-quality defects, and does not receive prior Luna findings or their resolutions.

### Plan handoff and limitations

The factual handoff identifies `plan-pipeline`, plan path, changed paths, checks and fresh evidence, assumptions, report summaries/references, unresolved questions/items, working directory, and observed Git state. It deliberately omits a READY/readiness decision.

Runs remain in-memory and session-scoped, are not resumable, and use the same independent Sol/Luna/Terra capacity pools and transcript/steer/cancel/takeover behavior as `feature-pipeline`. Multiple runs may target the same workspace because conflict prevention remains the caller's responsibility. Artifact validation proves plan structure, not product feasibility, stakeholder approval, or correctness of a future implementation.
