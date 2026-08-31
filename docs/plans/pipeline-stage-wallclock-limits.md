# Wallclock warning and hard limits for Pipi pipelines

> **Status:** Historical implementation plan. The shipped general stage limit is explicit-only: omitting `pipeline_run.wallclock_limit` disables hard per-stage timing. Feature implementation candidates additionally have independent 10-minute cooperative steering budgets (messages at 8 and 10 minutes) that do not cancel agents or fail the pipeline; those later budgets are separate from this plan's hard stage-limit contract.

> **User-facing feature:** A pipeline stage can have a configurable wallclock limit such as `5m`. At 80% Pipi warns active stage agents to wrap up and submit. At the hard deadline the controller stops work, preserves validated facts and bounded best-available output, releases resources, and returns a clearly time-limited handoff rather than hanging or claiming success.

## Goal and non-goals

Add two controller-owned limits to applicable stages in `feature-pipeline`, `small-feature-pipeline`, `plan-pipeline`, and `audit-pipeline`: a non-terminating warning at exactly 80% of the configured strict duration and a hard deadline at 100%. At expiry, a typed execution-finish contract preserves the best available result; if cooperative invocation cannot occur, is malformed/empty, or interruption fails, controller-owned fallback settles once, fails closed, and never claims completed/readiness.

**Timing decision:** limits apply per controller stage, not per child attempt and not once per whole run. A stage is the smallest authoritative boundary containing startup, root turns, concurrent children, fan-in, corrections/retries, synthesis, and remediation. All stage-owned sessions share one deadline. Replacement children, retries, and late sessions receive only remaining time and never reset it.

Only currently reachable model/waiting stages are timed:

- `feature-pipeline`: `discover`, `build`, `audit`, `audit-resolve`, `final-audit`, `final-resolve`;
- `small-feature-pipeline`: `build`, `final-audit`, `final-resolve`;
- `plan-pipeline`: `discover`, `synthesize`;
- `audit-pipeline`: `audit`.

This preserves the existing plan graph (`discover → synthesize → complete`); it does not invent plan audit/remediation stages. `complete` remains an untimed atomic validation/bookkeeping transition with no asynchronous model work. Tests must prove that invariant or implementation must introduce an explicit timed finalization stage through a separately accepted graph change.

Non-goals: generic workflow/direct-subagent deadlines; replacement of `CHILD_TOOL_CALL_TIMEOUT_MS` or audit executor timeout evidence; durable resume; browser/server/database/migration/deployment/telemetry work; graph/role/model/quota/Git-authority changes; preemption inside synchronous Git operations; or treating partial output as a valid report, accepted plan, finding resolution, completed run, or readiness claim.

## Evidence and assumptions

### Repository evidence

- `extensions/pipelines/domain.ts` defines four graphs, including plan `discover/synthesize/complete`, request/snapshot/handoff contracts, and statuses `starting | running | completed | failed | cancelled`; timing and limited outcomes are absent.
- `extensions/pipelines/controller.ts` owns `MutableRun`, initialization, direct stage assignments, fan-in/audit pumps, completion, failure, cancellation, delivery, and feature promotion/cleanup. `deliver` already suppresses duplicate handoffs.
- Root `pipeline_complete` enforces graph-specific gates. `extensions/pipelines/session.ts` has terminating typed discovery/plan/audit submissions, but no generic partial-finish contract. Session factories build custom tools and allowed names at creation.
- `extensions/shared/agent-tree/control.ts` exposes `send`, `wait`, `cancel`, `interrupt`, `dispose`, `liveAssistant`, and `finalText`. Agent nodes settle only through existing done/error/cancelled paths; `send` rejects deferred sessions. Plan/audit roots may be precreated/deferred. `session.ts` currently uses a real five-second interrupt timer.
- Current cancellation can await `rootReady`; root creation/assignment is asynchronous and readiness is not a safe prerequisite for hard-expiry cleanup.
- `audit-segment.ts` and `incremental-fan-in.ts` only finalize validated integration and use settlement/report state to drive correction and pumping. `feature-worktrees.ts` protects exact promotion and run-owned cleanup.
- `inspection.ts` computes elapsed values from civil `Date.now` timestamps. `dashboard.ts`, `index.ts`, and `cancellation.ts` project current status but do not distinguish warning or deadline limitation.
- `docs/pipelines-v1-design.md` makes runs in-memory and session-scoped: shutdown/reload/fork disposes or cancels rather than restores them. Inspection/handoffs are bounded and privacy-safe.
- Fake-session tests exist in controller/audit/session/cancellation/inspection/dashboard/index/feature test files. No reliable live-provider pipeline E2E harness exists.
- `package.json` declares deterministic, type, format, installer, and rollout checks.

### Selected contracts and assumptions

1. Add terminal status `limited` with structured `wallclock` limitation metadata; expiry is not success, provider failure, or user cancellation.
2. Add optional `pipeline_run.wallclock_limit` as canonical duration (`30s`, `5m`, `2h`). Omission uses typed source default. Validate before run/session/worktree creation; support 30 seconds through 24 hours and reject zero, negative, fractional, ambiguous, unknown-unit, non-finite, and overflow values. Do not use `config/pipi-model-overrides.json`.
3. One request duration independently applies to every reachable timed stage listed above. Warning ratio is fixed at `0.8`. Controller/session factory options inject policy, monotonic clock, scheduler, and interrupt-wait timer.
4. **Initial boundary:** after request/config/Git admission validation, controller synchronously inserts `MutableRun` and starts its initial stage budget before asynchronous initialization, session creation, discovery bootstrap, or feature lifecycle allocation. Thus `starting` counts. Later stages start only through centralized transition after valid prior-stage completion.
5. **Monotonic state and projections:** internal run and stage state records monotonic starts and terminal elapsed values. Every controller snapshot computes authoritative `runElapsedMs`, `stageElapsedMs`, and `remainingMs` from the injected monotonic clock (terminal snapshots use captured monotonic values). `startedAt`, `finishedAt`, `stageStartedAt`, `warningAt`, and `deadlineAt` remain civil display timestamps only. Inspection/dashboard consume projected durations and never recompute enforcement-related elapsed/remaining from `Date.now`. Expiry is `monotonicNow >= deadline`.
6. First synchronous terminal claim wins. Completion/cancellation/failure claimed before deadline keeps existing semantics; at/after boundary wallclock wins if no prior claim exists. Callbacks check run status, stage, and epoch.
7. **Stage/session ownership:** every session is registered with intended stage and epoch. A precreated future-stage root is dormant and receives no current warning. On stage activation it is rebound to the new epoch. A deferred current-stage session records `pendingWarningEpoch`; because `send` rejects it, controller injects warning into its one bootstrap/start prompt. Active or late-created current-stage sessions receive one steering message. `warnedEpoch` prevents duplicates.
8. **Tool wiring:** `pipeline_execution_finish` is registered at creation in custom tools and every explicit allowed-tool list, including root, plan discovery, audit, replacement, and feature-boundary sessions. Execute guard requires active run, matching epoch, and warning-reached token; before warning or after settlement it rejects without mutation. Correctness does not depend on dynamic tool registration.
9. **Cooperative-partial lifecycle:** successful partial finish writes a controller-owned `PipelineExecutionSettlement { kind: "partial", agentId, role, stage, epoch, submittedAtMonotonic }` before the tool returns `terminate = true`. The agent tree may subsequently report ordinary `done`, but `onTreeChange`, fan-in, and audit pumps consult this settlement first. It is excluded from valid-report counts, malformed-submission corrections, provider-failure handling, retry-exhaustion accounting, and completion gates. It is not `failed` or `cancelled`. No automatic replacement is spawned in v1; the stage remains running until deadline or until an already-permitted explicit replacement submits a valid report. Such a replacement inherits remaining time; a valid report may satisfy the role gate while the earlier partial remains provenance-only. If gates remain unmet, hard expiry settles `limited`.
10. At expiry controller invokes internal `finishExecution(origin: "deadline-fallback")` for sessions without cooperative settlement, using bounded `liveAssistant`/`finalText`. Free-form output is labelled unvalidated and never passed as a typed report.
11. **Root-readiness-independent cleanup:** hard expiry never awaits `rootReady` and never reuses a cancellation path that does. Run state tracks every successfully created session ID incrementally; expiry snapshots that set and cleans known sessions immediately. Every initialization branch resolves readiness in `finally` (or replaces readiness with nonblocking state). A spawn promise resolving after terminal claim must observe inactive epoch, register no work, and immediately dispose its session. Cleanup/handoff waits only on the injected bounded teardown timer, not unresolved creation/readiness.
12. Controller claims `limited` and invalidates timers/tools before teardown. One memoized teardown uses injected bounded interrupt wait, disposal, `Promise.allSettled`, idempotent feature cleanup, and exactly-once handoff. Cleanup errors are diagnostics, not status changes.
13. **Field-level contract:** active snapshots add `PipelineStageTiming { stage, durationMs, stageStartedAt, warningAt, deadlineAt, warningState, stageElapsedMs, remainingMs }` and top-level `runElapsedMs`. Limited snapshots/handoffs add `PipelineWallclockLimitation { kind: "wallclock", expiredStage, durationMs, elapsedMs, deadlineAt, validatedProgress, partialExecutions, diagnostics, unresolved }`. `validatedProgress` contains role/count identifiers and optional accepted `planPath`, final-audit count, `promotionState`, and `cleanupState`, never raw reports. Each partial execution contains `agentId`, `role`, `provenance: "cooperative" | "live-assistant" | "final-text" | "none"`, optional `output`, `truncated`, evidence, and unresolved. Bound output to 8 KiB per execution/32 KiB aggregate; at most 64 executions; evidence/unresolved/diagnostics at 64 entries each/2 KiB each. List/dashboard expose summaries/counts only; detailed check/handoff may show bounded previews.
14. Rich handoff construction normalizes/truncates before projection. If delivery/tool/output/interruption fails, minimal prevalidated limitation records definition, expired stage, elapsed/limit, validated counts/artifacts, and unresolved work; no output is acceptable, hanging or false success is not.
15. Restart/reload continues to cancel/dispose, clears controller and interrupt timers, and does not restore deadlines. Proposed source default is `30m`; repository telemetry cannot calibrate it, so owner confirmation remains open.

## Candidate acceptance criteria

- **AC-001:** Canonical duration validates before run/session/Git allocation; omission uses documented default; only reachable listed stages are timed and `complete` is not.
- **AC-002:** Initial timing starts at `MutableRun` insertion before async initialization; later timing starts at centralized stage entry. Startup, bootstrap, retries, and replacements cannot bypass/reset it.
- **AC-003:** At 80%, active current-stage sessions get one steering warning, current-stage deferred sessions get it in bootstrap, future-stage precreated sessions get none until rebound, and late sessions get one immediate warning.
- **AC-004:** Finish tool is registered for every session list but mutates only with matching active warning epoch. Partial settlement precedes ordinary done, is excluded from valid/correction/failure/retry accounting, and cannot satisfy gates.
- **AC-005:** Partial finish causes no automatic replacement or premature terminal result. Explicitly permitted replacement inherits remaining time; valid replacement can satisfy a gate; otherwise stage remains active until strict expiry.
- **AC-006:** At `now >= deadline`, one claim blocks new work, invokes fallback finish, and settles `limited` without awaiting root readiness. Late spawn completion disposes immediately.
- **AC-007:** Limited handoff follows bounded schema, preserves accepted progress, labels provenance/truncation, and provides minimal factual output for malformed/empty/unavailable paths without fabricated success.
- **AC-008:** Completion/cancellation/failure before boundary keeps old meaning; exact-boundary expiry wins otherwise. Concurrent actions, stale events, and repeated disposal yield one outcome/cleanup/handoff.
- **AC-009:** All stage/terminal/dispose paths clear timers. Known sessions, deferred roots, corrections, pumps, worktrees, and interrupt timers stop boundedly; unresolved root creation/readiness cannot block handoff.
- **AC-010:** Four existing graphs keep topology/gates. Plan timing covers only `discover/synthesize`. Incomplete audit/plan is not finalized. Pre-promotion expiry preserves caller HEAD; post-promotion expiry preserves verified promotion.
- **AC-011:** Inspection/list/dashboard/status/cancel/handoff distinguish warning/limited, use monotonic projected elapsed/remaining, enforce bounds, and remain privacy/narrow-terminal safe despite civil-clock jumps.
- **AC-012:** Shutdown/reload disposes without resume. Existing per-tool timeouts/full gates/outcomes/quota exclusion remain intact.
- **AC-013:** Fake-clock tests with no real waiting cover startup, deferred warning, partial accounting, hard expiry, unresolved root readiness, civil jumps, malformed/no output, injected interrupt timeout, cleanup, and all graphs.
- **AC-014:** User/design docs cover configuration, warning, partial lifecycle, fallback, bounds, default, restart, rollout/rollback; implementation adds setup record.

## Frontend tasks

No browser frontend exists. Applicable surfaces are Pi TUI, inspection, status bar, and handoff.

### TASK-006: Project monotonic warning and limited state through inspection and TUI

- **Scope:** Render warning-active and `limited` with warning/neutral semantics. Consume controller-projected monotonic elapsed/remaining values; retain civil timestamps only as labels. Detailed check/handoff may show bounded provenance previews; list/dashboard show counts. Preserve hierarchy, keyboard behavior, selection, refresh, truncation, and privacy.
- **Likely paths/components:** `extensions/pipelines/inspection.ts`, `dashboard.ts`, `index.ts`, `cancellation.ts`; corresponding tests.
- **Dependencies:** TASK-001, TASK-004.
- **Acceptance/verification evidence:** AC-007, AC-011, AC-012; pre-warning/warned/expiry tests, backward/forward civil clock jumps with unchanged monotonic projection, limited styling, bounds, cancellation already-settled, all layouts.

## Backend tasks

Server/API/storage work is not applicable. In-process orchestration and session/Git lifecycle are applicable.

### TASK-001: Define duration, timing, partial settlement, limitation, and bounds contracts

- **Scope:** Add `limited`, exact monotonic projection/timing/limitation/partial-settlement types and bounds, optional duration, parser/resolver, and injectable controller/interrupt schedulers. Validate before `MutableRun` allocation.
- **Likely paths/components:** new `extensions/pipelines/wallclock.ts`; `domain.ts`; `index.ts` schema; controller/session factory options; new `wallclock.test.ts`, `index.test.ts`.
- **Dependencies:** none.
- **Acceptance/verification evidence:** AC-001, AC-007, AC-012; parser/default/arithmetic/bounds tests, exhaustive status handling, invalid admission with no run/factory/Git call.

### TASK-002: Centralize stage entry, session ownership, and monotonic projections

- **Scope:** Start initial timer at run insertion. Replace direct stage writes with one helper that clears handles, increments epoch, records monotonic/civil timing, rebinds dormant sessions, and arms callbacks. Track run/session monotonic state and compute snapshot elapsed/remaining. Register intended/current epoch and guard transitions.
- **Likely paths/components:** `MutableRun`, start/initialization/spawn/deferred hooks, snapshot, fan-in transition, `setStage`, audit completion, complete/fail/cancel/dispose in `controller.ts`; `wallclock.ts`.
- **Dependencies:** TASK-001.
- **Acceptance/verification evidence:** AC-002, AC-003, AC-006, AC-008, AC-009, AC-011; startup, re-arm, ownership, no reset, stale no-op, civil-jump, terminal elapsed, cleanup tests.

### TASK-003: Wire warning and cooperative partial settlement into every session kind

- **Scope:** Register finish tool in every custom/explicit list; gate by warning/epoch/active state. Steer active sessions, queue deferred bootstrap warning, suppress future-stage warnings. Atomically write partial settlement before termination. Update tree/fan-in/audit handling to exclude partial from report validation, correction, failure, retry, and completion. Implement no-auto-replacement and explicit-replacement remaining-time policy.
- **Likely paths/components:** `session.ts`; root/child/plan/audit/replacement/feature-boundary construction and `onTreeChange` in `controller.ts`; `agent-tree/control.ts` deferred hook; `incremental-fan-in.ts`, `audit-segment.ts`, `prompt.ts`; session/controller/audit tests.
- **Dependencies:** TASK-001, TASK-002.
- **Acceptance/verification evidence:** AC-003–AC-005, AC-007; active/deferred/future/late/tool-list matrix, pre-warning/post-terminal rejection, partial-before-done event ordering, accounting exclusions, no correction loop, no automatic replacement, explicit valid replacement, no premature progress.

### TASK-004: Implement root-independent hard-expiry and fail-closed settlement

- **Scope:** Add first-winner claim and unified finish path. Normalize output into exact bounded schema or minimal fallback. Track created session IDs; hard expiry snapshots/cleans them without awaiting `rootReady`. Settle readiness on all initialization exits, dispose late-resolving spawns, invalidate tools/timers, settle `limited`, then use memoized bounded cleanup/delivery.
- **Likely paths/components:** `controller.ts` initialization/readiness/spawn/events/guards/settlement/facts/delivery/teardown; `session.ts` interrupt timer injection; optional audit progress helper.
- **Dependencies:** TASK-002, TASK-003.
- **Acceptance/verification evidence:** AC-006–AC-009; unresolved/rejected/late root spawn, exact-boundary races, malformed/empty/throwing output/builder, interrupt timeout/failure with fake scheduler, one handoff, immutable state, zero timers.

### TASK-005: Preserve reachable graph, audit, and feature Git invariants

- **Scope:** Apply timing only to listed reachable stages; stop fan-in/corrections/reducer/synthesis after claim without manufacturing finals. Guard synchronous Git before/after, track promotion/cleanup, never roll back verified promotion. Prove `complete` has no async work. Preserve plan `discover → synthesize → complete` topology.
- **Likely paths/components:** `domain.ts`, `controller.ts`, `prompt.ts`, `audit-segment.ts`, `incremental-fan-in.ts`, `feature-worktrees.ts`; controller/audit/feature/dashboard tests.
- **Dependencies:** TASK-004.
- **Acceptance/verification evidence:** AC-008–AC-010, AC-012; exact four-graph stage matrix, plan topology test, audit races/retries, plan identity, Git HEAD/tree/ref/cleanup assertions, immediate-complete evidence.

## DevOps tasks

CI/CD, deployment, migration, and external observability are not applicable. Source policy, managed installation, docs, and rollback are applicable.

### TASK-007: Document and verify rollout and rollback

- **Scope:** Document default, grammar/range, ratio, stage/start scope, partial lifecycle, limitation bounds, monotonic display semantics, and restart behavior. Confirm installer copies new modules. Append setup record. Roll back after stopping sessions by restoring source/schema/docs and reinstalling.
- **Likely paths/components:** concise `README.md`; `docs/pipelines-v1-design.md`; `docs/pipi-setup-record.md`; `wallclock.ts`; `tests/scripts/`; `SETUP.md` only if needed.
- **Dependencies:** TASK-001, TASK-006, TASK-008, TASK-009.
- **Acceptance/verification evidence:** AC-001–AC-003, AC-010–AC-012, AC-014; docs/code/schema agree, installed extension loads, setup record captures request/action/paths/values/checks/pending calibration without secrets.

## Cross-cutting tasks

### TASK-008: Build deterministic timing and contract coverage

- **Scope:** Add fake monotonic/controller/interrupt schedulers with timer inspection and microtask flushing. Cover admission/startup, session ownership, tool gates, partial lifecycle/accounting/replacement, expiry/readiness, races, malformed/no output, cleanup/restart, civil-clock jumps, projections, and graph/Git/audit invariants. No sleeps/providers/prompt-text matching/tolerances.
- **Likely paths/components:** new `wallclock.test.ts` and helper; controller/audit/session/inspection/dashboard/cancellation/index/feature tests.
- **Dependencies:** TASK-001, TASK-002, TASK-003, TASK-004, TASK-005, TASK-006.
- **Acceptance/verification evidence:** AC-001–AC-013; schema/tool/state/outcome assertions, one-winner counts, empty timer inventory, exact reachable-stage matrix, zero real waiting.

### TASK-009: Align controller contracts and design guidance

- **Scope:** Explain reachable stage scope, start/ownership, deferred warning, partial event/accounting/replacement, root-independent fallback, bounded schema, monotonic projection, restart, and Git critical sections. Test behavior rather than prompt prose.
- **Likely paths/components:** `prompt.ts`, root tool descriptions in `controller.ts`, `docs/pipelines-v1-design.md`; controller/session behavior tests.
- **Dependencies:** TASK-003, TASK-004, TASK-005, TASK-008.
- **Acceptance/verification evidence:** AC-002–AC-007, AC-010–AC-012, AC-014; prompts/tools/state/docs share one contract without graph or completion-gate drift.

### TASK-010: Run repository and operational acceptance checks

- **Scope:** Run focused tests, full deterministic suites, type/format/diff checks, installed-copy/exhaustive-status search, and managed installer verification. Optional live-provider smoke is non-gating and recorded as unproven/skipped.
- **Likely paths/components:** `package.json`, deterministic runner, installer/check scripts, repository and installed extension status consumers; no CI/deployment files.
- **Dependencies:** TASK-007, TASK-008, TASK-009.
- **Acceptance/verification evidence:** AC-013, AC-014; fresh focused `bun test`, `bun run test:extensions`, `bun run test:deterministic`, `bun run check`, `bun run format:check`, `git diff --check`, installed/status search, `bun run install:pipi -- --skip-repository-dependencies`, `bun run check:pipi-install`.

## Test plan

- **Unit — applicable:** duration/default/range; bounds/truncation/provenance; partial settlement/accounting reducer; 80% arithmetic; monotonic/civil separation; timer order; before/equal/after deadline; epochs; minimal handoff; controller/interrupt timer clearing.
- **Integration — applicable:** admission/startup; active/deferred/future/late sessions; fan-in/retries; partial done event and explicit replacement; audit pending/busy/final; full/partial/fallback output; unresolved/rejected/late root spawn; throwing interrupt/dispose/builder; cancellation/failure; shutdown; one teardown/handoff.
- **Contract — applicable:** additive request; status/timing/limitation/partial schema and bounds; all tool lists/gates; unchanged full gates; reachable graph stages; inspection/list/cancel/dashboard/status; monotonic projections and privacy.
- **E2E — automated live-provider gate not applicable:** no reliable harness. Optional disposable smoke cannot replace deterministic evidence or prove interruption behavior.
- **Operational — applicable:** focused tests; full extension/deterministic/type/format/diff checks; exhaustive consumer search; installer/check.
- **Required deterministic cases:** initial timer before async bootstrap; deferred/future/late warning; finish tool everywhere but gated; partial map written before done; excluded from validation/correction/failure/retry; no auto replacement; explicit replacement with remaining time; expiry at 100%; completion/cancel/fail boundaries; stale callbacks; unresolved rootReady/spawn plus late disposal; malformed/empty/unavailable/throwing output; bounds; injected interrupt timeout; backward/forward civil jumps with stable monotonic elapsed/remaining; no resources/timers; restart no restore; exact four-graph reachable-stage matrix; feature pre/post-promotion; incomplete audit/plan not finalized.

## Implementation waves

1. **Wave 1 — Domain/configuration:** TASK-001.
2. **Wave 2 — Timer, ownership, projections:** TASK-002.
3. **Wave 3 — Partial session lifecycle:** TASK-003.
4. **Wave 4 — Root-independent strict settlement:** TASK-004.
5. **Wave 5 — Graph and projection invariants:** TASK-005, TASK-006.
6. **Wave 6 — Deterministic evidence:** TASK-008.
7. **Wave 7 — Contract guidance:** TASK-009.
8. **Wave 8 — Documentation/installer:** TASK-007.
9. **Wave 9 — Fresh checks:** TASK-010.

## Risks, rollout, and rollback

- **False success:** `limited` stays distinct; fallback text never enters report/plan/audit validators.
- **Graph drift:** time only reachable stages; plan remains discover/synthesize/complete.
- **Partial settlement loops:** controller map precedes done event; fan-in excludes partial; no auto replacement; existing explicit replacement inherits remaining budget.
- **Startup/readiness hang:** timer starts before initialization; hard expiry never awaits rootReady; known sessions clean immediately; late sessions self-dispose.
- **Tool wiring drift:** register/test all lists; controller warning token is authoritative.
- **Races/duplicates:** synchronous claim, epoch, guards, memoized teardown, handoff set, checks at every transition.
- **Clock/timer inconsistency:** monotonic enforcement/projection plus injected controller/interrupt schedulers; civil timestamps are labels only.
- **Cleanup/Git/audit failure:** claim first, bounded all-settled cleanup, no mid-Git preemption, preserve promotion, freeze pumps, never finalize partial reducer state.
- **Compatibility/privacy:** update exhaustive consumers atomically; preserve old timeout/cancel meanings; enforce bounds; search local/installed integrations.
- **Uncalibrated default:** document default plus override; adjust through reviewed source policy.
- **Rollout:** focused fake-clock tests, full checks/search, docs/setup record, installer/check, optional non-gating smoke; avoid mixed active versions.
- **Rollback:** stop sessions, restore prior source/schema/docs, rerun checks, reinstall. No durable migration/restoration.

## Unresolved questions

1. **Default duration:** no telemetry supports one value. Confirm or replace proposed `30m` before coding; per-request configuration and semantics remain unchanged.
2. **External status consumers:** local evidence cannot prove outside exhaustive decoders; search available and installed integrations before merge and use an additive/versioned adapter if needed.
3. **Live provider behavior:** fakes cannot prove useful post-interrupt output, so minimal fail-closed handoff remains mandatory even if optional smoke succeeds.
