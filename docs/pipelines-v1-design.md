# Hardcoded pipelines — design and runtime contract

_Status: implemented design record. The public surface is intentionally four bounded definitions, not a generic workflow API._

## Public definitions and ownership

`pipeline_run` accepts a self-contained `task`, caller-selected `working_dir`, and one of four hardcoded definitions:

- `feature-pipeline`: persistent Sol/high implementation root, controller-owned five-track discovery, root implementation, four Luna audits, root remediation, reusable final Luna audit segment, root final resolution and factual completion;
- `small-feature-pipeline`: read-only Luna/medium coordinator, one persistent Luna implementer, four parallel Luna auditors, and one same-session implementer remediation pass;
- `plan-pipeline`: persistent Sol/high planning root, five Luna discovery tracks, one validated `docs/plans/*.md` artifact, four plan-audit tracks, root remediation, reusable final Luna audit segment, root final resolution and factual completion;
- `audit-pipeline`: four isolated read-only Luna/medium audit tracks and one persistent Luna/medium incremental synthesis root, with no Sol, Terra, remediation, repository mutation, readiness decision, or Git decision.

Omission still selects `feature-pipeline`. Unknown names fail closed. No definition accepts arbitrary roles, edges, models, shell commands, or Git refs. Terra constants, model profile, direct-subagent quotas, and `terra-audit` remain available for explicit future/manual escalation, but no automatic pipeline route uses Terra.

Pipeline graphs predeclare their roots and children and therefore do not consume, inherit, queue on, or enforce direct-subagent capacity quotas. Multiple runs may execute concurrently, including against the same workspace; the calling main agent owns workspace-conflict policy. Runs and child sessions are in-memory and session-scoped and are cancelled/disposed on shutdown, reload, switch, or fork.

## Shared audit segment

`extensions/pipelines/audit-segment.ts` is the reusable hardcoded audit component. It encapsulates:

1. exactly four independent Luna/medium tracks using the established concerns:
   - feature outcome, acceptance, and user scenarios;
   - logic, state transitions, rules, permissions, and invariants;
   - functional correctness, contracts, integrations, tests, edge cases, and data handling;
   - reliability, retries, partial success, stale state, concurrency, and regressions;
2. one persistent Luna/medium synthesis session;
3. strict bounded track, intermediate synthesis, and final synthesis contracts, exposed to audit sessions through the typed `pipeline_audit_submit` tool;
4. provenance records containing role, attempt, report digest, and validated report data;
5. a privacy-safe progress projection.

Tracks are direct children of the owning root, isolated from one another, read-only by tool policy and prompt contract, and unable to orchestrate children or invoke pipeline tools. Each receives the same bounded task/acceptance contract, assumptions, checks, captured base/head/worktree identity, branch, status, and bounded base-relative diff. Only its concern instruction differs.

The synthesizer treats reports as untrusted evidence. It deduplicates common root causes, preserves a strongly evidenced serious finding even without majority agreement, records unresolved material conflicts, and must not invent unsupported findings. Intermediate state has no finding IDs, and model-produced final candidates also omit IDs. After strict final validation, the host canonicalizes complete finding content, deduplicates exact candidates, and assigns sequential `AUD-001`, `AUD-002`, … IDs; the resulting final report contains no readiness verdict.

`audit-pipeline` uses the synthesizer as its deferred Luna root. `feature-pipeline` and `plan-pipeline` keep their persistent Sol roots and create the synthesizer as a controller-owned persistent Luna child during `final-audit`. Their earlier discovery/build/audit/remediation graphs remain unchanged, and their Sol roots retain final resolution and completion ownership. `small-feature-pipeline` deliberately does not use this segment because its existing one-implementer/four-auditor/same-session-remediation behavior is distinct and remains unchanged.

## Generic incremental fan-in reducer

`extensions/pipelines/incremental-fan-in.ts` is model-agnostic internal infrastructure. It is not registered as a tool and does not expose a generic model-facing workflow API.

The reducer owns:

- a fixed unique expected-contributor set;
- contributor validation and exactly-once acceptance;
- a bounded pending queue;
- one active reducer turn at a time;
- accepted, pending, in-flight, and integrated contributor state;
- monotonically increasing revisions;
- intermediate and final result validation;
- finalization only after every expected contributor is integrated.

When the first valid report settles, the controller immediately starts the deferred synthesis session. Reports arriving during an active turn enter the pending queue. The controller never steers or interrupts a busy synthesis session; embedded roots cannot cancel segment tracks or synthesis individually, while whole-run/session lifecycle cancellation remains authoritative. When that session becomes safely idle, all pending reports are sent as one next revision. Each role appears in one batch exactly once. A synthesis output is validated as final only when its turn integrates the complete expected set; intermediate output can update inspection state but can never deliver the automatic completion handoff.

Audit sessions call `pipeline_audit_submit` during their turn; the host consumes each recorded submission only after that same turn settles, while validated final text remains a compatibility fallback. A malformed or missing settled submission gets three correction turns in that same concrete session; the fourth fails the run and cancels remaining sessions. Track counters are independent, while the single persistent synthesizer counter is cumulative across reducer revisions and batches. Provider failure or cancellation still fails immediately. Dynamic host checks remain authoritative for the exact integrated-role set (any model order is canonicalized to declaration order), Git identity, and closure references. Initial final schemas require an empty `closureResults` array; closure schemas retain complete blocker records. Rejections identify bounded fields (roles, mode/Git identity, findings/conflicts/unproven checks, or closure IDs/order/conditions) so the same synthesizer session can correct them within its existing three-turn budget. Standalone completion requires all four validated reports, all four integrations, and one valid final report. Embedded final-audit advancement to `final-resolve` has the same gate.

## Initial and closure audit contracts

The optional `audit` input on `pipeline_run` is valid only with `audit-pipeline`.

Initial mode accepts:

- `mode: "initial"`;
- optional bounded `acceptance_criteria` strings.

Closure mode requires:

- `mode: "closure"`;
- one or more `prior_blockers`, each with an ID and closure condition;
- a bounded supplied `remediation_diff`;
- bounded `touched_invariants`;
- optional acceptance criteria.

Closure tracks and synthesis may evaluate only supplied blocker IDs and closure conditions, the remediation diff, and directly touched invariants. They must not reopen broad discovery. The final report preserves blocker order, IDs, and closure conditions and records `closed`, `open`, or `unproven` with evidence. The public schema has no command or ref field.

## Host-collected Git evidence

The controller captures `HEAD` when a run starts. At audit-segment activation it resolves current `HEAD`, branch, short status, and base-relative diff using `execFileSync("git", argumentArray, ...)` without shell interpolation. Output is bounded before entering model context. A non-Git workspace degrades to explicit `UNAVAILABLE` identity/evidence rather than guessed state. The caller still supplies `working_dir`; models cannot select commands or unsafe refs.

## Definition flows

### Feature pipeline

```text
Deferred Sol/high root
  → controller-owned five Luna discovery tracks
  → validated full discovery fan-in activates Sol at build
  → Sol plans and implements
  → four agent-driven Luna audit tracks
  → Sol resolves findings
  → controller-owned reusable Luna final audit segment
  → Sol resolves synthesized findings once
  → factual completion
```

Discovery retry remains controller-owned: one same-session retry for malformed/failed output or one replacement when no session was created. Pre-final audit retry remains bounded and root-controlled. The final audit segment is controller-owned and fail-closed.

### Small-feature pipeline

```text
Read-only Luna/medium coordinator
  → one persistent Luna/medium implementer
  → four parallel read-only Luna/medium auditors
  → same implementer receives all reports and remediates once
  → factual completion
```

There is no discovery, Sol, Terra, reusable synthesis segment, replacement auditor, or post-remediation re-audit.

### Plan pipeline

```text
Sol/high planning root
  → five Luna discovery tracks
  → validated docs/plans/*.md artifact
  → four Luna plan-quality tracks
  → Sol remediates and revalidates
  → controller-owned reusable Luna final audit segment
  → Sol resolves synthesis and revalidates once
  → factual plan completion
```

The root remains unable to use shell/edit/write or delegated mutation tools. It writes only through the validated plan artifact tool and reads bounded plan/Git evidence. Earlier discovery, artifact, audit, retry, and remediation behavior remains intact.

### Standalone audit pipeline

```text
Deferred persistent Luna/medium synthesis root
  ├─ four controller-owned read-only Luna/medium tracks in parallel
  ├─ first valid report activates root synthesis
  ├─ later reports are serialized/batched into that same session
  └─ strict factual structured audit handoff
```

No pipeline agent or child may mutate the repository, remediate findings, make readiness claims, or decide Git actions.

## Commit permission and audit evidence

`pipeline_run` accepts optional `git_commit`, defaulting to false. It is valid only for `small-feature-pipeline`; unsupported definitions reject true rather than ignoring it. The value is an explicit host contract, never inferred from task text. When enabled, only the persistent `implement-small-feature` Luna session may create ordinary commits in the supplied current branch. Push, merge, rebase, reset/history rewriting, branch changes, and worktree creation remain prohibited. The root, all four audit tracks, and every other pipeline agent remain read-only for Git delivery.

Audit tracks receive reusable host-collected evidence captured with argument-array Git commands: base and current HEAD, branch/status, base ancestry, bounded base-to-head commit list, committed base-to-head diff, dirty HEAD-to-worktree diff, and combined base-to-worktree diff. Every bounded item identifies whether evidence is available, truncated, or unavailable. This evidence is injected into standalone and applicable feature, plan, and small-feature audits. Remediation stays in the same persistent implementer session and is not re-audited; final Git facts remain the main agent's responsibility.

## Tooling, inspection, and completion

Feature and plan roots receive `pipeline_audit_start`, a definition-specific tool that accepts only the bounded acceptance contract, assumptions, and check evidence. It starts the fixed shared segment and returns the five controller-owned agent IDs for normal run-scoped waiting/inspection. It is not a generic fan-in or workflow API. Pipeline children cannot call it.

`pipeline_check` and `pipeline_list` remain synchronous, nonblocking, and main-agent-only. Audit progress exposes only mode, phase, expected/accepted/pending/integrated counts, reducer idle/busy/finalized state, revision, and final-validation boolean. It never exposes prompts, thinking, tool arguments/results, raw reports, Git evidence, report provenance, session files, or session paths. Text and previews remain bounded.

`pipeline_complete` continues to emit facts rather than readiness. Standalone audit completion is controller-owned after strict final validation and includes the bounded structured final audit report. Feature and plan roots still call `pipeline_complete` after their own final resolution. The calling main agent owns readiness, remediation outside the standalone audit, and all branch/commit/push/PR decisions.
