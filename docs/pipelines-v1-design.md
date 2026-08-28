# Hardcoded pipelines — design and runtime contract

_Status: implemented design record. The public surface is intentionally four bounded definitions, not a generic workflow API._

## Public definitions and ownership

`pipeline_run` accepts a self-contained `task`, caller-selected `working_dir`, and one of four hardcoded definitions:

- `feature-pipeline`: persistent Sol/high implementation root, controller-owned five-track discovery, root implementation, four Luna audits, root remediation, reusable five-contributor final Luna audit segment, root final resolution and factual completion;
- `small-feature-pipeline`: read-only Luna/medium coordinator, one persistent Luna implementer, four parallel Luna auditors, and one same-session implementer remediation pass;
- `plan-pipeline`: persistent Sol/high planning root, five Luna discovery tracks, one validated `docs/plans/*.md` artifact, four plan-audit tracks, root remediation, reusable five-contributor final Luna audit segment, root final resolution and factual completion;
- `audit-pipeline`: four isolated read-only Luna/medium static audit tracks, one trusted-workspace Luna/medium audit-executor contributor, and one persistent Luna/medium incremental synthesis root, with no Sol, Terra, remediation, readiness decision, or Git decision.

Omission still selects `feature-pipeline`. Unknown names fail closed. No definition accepts arbitrary roles, edges, models, shell commands, or Git refs. Terra constants, model profile, direct-subagent quotas, and `terra-audit` remain available for explicit future/manual escalation, but no automatic pipeline route uses Terra.

Before invoking `feature-pipeline` or `small-feature-pipeline`, the calling main agent creates a dedicated linked Git worktree on its own local branch, runs the repository-declared dependency/bootstrap/build preparation there, and passes the exact worktree root as `working_dir`. Preparation is repository-specific and caller-owned: the controller does not create branches/worktrees, install dependencies, run builds, or guess commands. The host deterministically verifies the exact registered linked-worktree root and named-branch topology, but does not claim to prove that caller-reported preparation commands ran. `plan-pipeline` and `audit-pipeline` retain their existing workspace policy.

Implementation-workspace admission occurs synchronously before the run ID/state is created or any root/child model session starts. It rejects the repository primary checkout, non-Git and bare directories, detached worktrees, unregistered or non-root paths, and a branch registered to another worktree. It does not require cleanliness, a target branch, or a particular branch name.

Pipeline graphs predeclare their roots and children and therefore do not consume, inherit, queue on, or enforce direct-subagent capacity quotas. Multiple runs may execute concurrently, including against the same workspace; the calling main agent owns workspace-conflict policy. Runs and child sessions are in-memory and session-scoped and are cancelled/disposed on shutdown, reload, switch, or fork.

## Shared audit segment

`extensions/pipelines/audit-segment.ts` is the reusable hardcoded audit component. It encapsulates:

1. exactly five independent Luna/medium contributors:
   - four static read-only tracks covering feature outcome, logic/invariants, functional correctness, and reliability/regressions;
   - one `audit-executor` contributor that inspects manifests/scripts and runs bounded existing noninteractive verification with cheap checks first;
2. one persistent Luna/medium synthesis session;
3. strict bounded track, intermediate synthesis, and final synthesis contracts, exposed to audit sessions through the typed `pipeline_audit_submit` tool;
4. provenance records containing role, attempt, report digest, and validated report data;
5. a privacy-safe progress projection.

Contributors are direct children of the owning root, isolated from one another, and unable to orchestrate children or invoke pipeline tools. The four static tracks remain shell-denied and read-only by tool policy and prompt contract. Exactly feature `discover-problem` (F1) and plan `discover-goal-outcomes` (P1) additionally keep ordinary `bash` to invoke installed `gh` for read-only, task-referenced GitHub issue/epic bodies, comments, labels, and native parent/sub-issue relationships; those prompts treat fetched text as untrusted evidence and prohibit all other shell use and mutations. The executor alone otherwise keeps ordinary `bash` plus read/search tools under the accepted trusted-workspace model; edit/write/patch/delegation/MCP/background/pipeline/workflow/subagent/user-prompt tools remain denied. Each contributor receives the same bounded task/acceptance contract, assumptions, checks, captured base/head/worktree identity, branch, status, and bounded base-relative diff.

The executor prompt requires manifest/script inspection before execution, cheap checks first, and repository-declared noninteractive verification rather than language/framework adapters. In standalone and feature final-audit contexts it explicitly requires the repository-declared noninteractive repository-wide full test suite(s) after useful focused checks; targeted, package-level, or affected-scope tests do not substitute. If no safe full suite exists or it fails, times out, or cannot run under the contract, the executor records exact evidence and an `unprovenChecks` entry without inventing a command. Plan final-audit behavior remains unchanged: product implementation tests are prohibited. The executor prohibits intentional source/config edits, formatter/fixer or snapshot-update modes, dependency installation/update, mutating Git, network/external-state mutation, interactive/watch/server/long-lived commands, delegation/orchestration, and user prompting. Ambiguous or unsafe scripts are skipped with evidence. Its strict bounded report preserves exact commands, `passed | failed | timed_out | skipped` status, available exit code, output/evidence summary, observed workspace changes, findings, and unproven checks. Command failure is not automatically a behavior finding.

Feature and standalone contexts permit normal relevant project verification. Plan final-audit context permits only plan/artifact validation or check-only commands demonstrably relevant to the planning deliverable; implementation tests/builds/linters/typechecks are skipped as unsupported rather than run blindly. Closure mode remains limited to prior blockers, remediation, and touched invariants. `small-feature-pipeline` deliberately keeps its separate four-static-auditor graph.

The synthesizer treats reports as untrusted evidence. It deduplicates common root causes, preserves a strongly evidenced serious finding even without majority agreement, records unresolved material conflicts, and must not invent unsupported findings. Executor execution records and host workspace observations are bounded, schema-valid evidence: the model may summarize or paraphrase them, including reordered records, without byte-for-byte copying. Before audit-executor is integrated, the model-facing arrays remain empty and the host observation remains null; after integration, malformed, missing, oversized, or unsafe evidence still fails validation. The host preserves authoritative executor and host evidence in the final report. Intermediate state has no finding IDs, and model-produced final candidates also omit IDs. After strict final validation, the host canonicalizes complete finding content, deduplicates exact candidates, and assigns sequential `AUD-001`, `AUD-002`, … IDs; the resulting final report contains no readiness verdict.

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

Audit sessions call `pipeline_audit_submit` during their turn; the host consumes each recorded submission only after that same turn settles, while validated final text remains a compatibility fallback. A malformed or missing settled submission gets three correction turns in that same concrete session; the fourth fails the run and cancels remaining sessions. Track counters are independent, while the single persistent synthesizer counter is cumulative across reducer revisions and batches. Provider failure or cancellation still fails immediately. Dynamic host checks remain authoritative for the exact integrated-role set (any model order is canonicalized to declaration order), Git identity, and closure references. Initial final schemas require an empty `closureResults` array; closure schemas retain complete blocker records. Rejections identify bounded fields (roles, mode/Git identity, findings/conflicts/unproven checks, or closure IDs/order/conditions) so the same synthesizer session can correct them within its existing three-turn budget. Standalone completion requires all five validated contributor reports, all five integrations, and one valid final report. Embedded final-audit advancement to `final-resolve` has the same gate.

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

The controller captures `HEAD` when a run starts. At audit-segment activation it resolves current `HEAD`, branch, short status, and base-relative diff using `execFileSync("git", argumentArray, ...)` without shell interpolation. After executor settlement it captures fresh bounded status plus dirty/combined diff evidence, compares it observationally with activation evidence, and carries the result into synthesis/final facts without rollback. Output is bounded before entering model context. For plan and audit, a non-Git workspace continues to degrade to explicit `UNAVAILABLE` identity/evidence rather than guessed state. Feature and small-feature admission instead requires the caller-prepared linked worktree described above. The caller still supplies `working_dir`; the public API exposes no arbitrary commands or refs.

## Definition flows

### Feature pipeline

```text
Deferred Sol/high root
  → controller-owned five Luna discovery tracks
  → validated full discovery fan-in activates Sol at build
  → Sol plans and implements
  → four agent-driven Luna audit tracks
  → Sol resolves findings
  → controller-owned reusable five-contributor Luna final audit segment
  → Sol resolves synthesized findings once
  → factual completion
```

Feature discovery remains controller-owned, parallel, and read-only by tool policy. Its sessions retain `read`, `fd`, `rg`, and deterministic read-only web search/fetch when available, while shell/edit/write, delegated patch/task tools, MCP, background mutation, user interaction, and pipeline/workflow/subagent orchestration are denied. No discovery tool is exposed to plan discovery or any non-feature-discovery session.

Each track has a role-fixed TypeBox `feature-discovery-v2` schema and matching host validation. The common envelope carries applicability, a bounded synthesis, coverage in exact deterministic role order, typed evidence, candidate acceptance records, actionable unknown/safe-assumption records, and sourced constraints. The ordered criteria are:

- problem: actor/job, current behavior, problem or opportunity, observable consequence, boundaries, non-goals, neighboring flows;
- outcome: primary, alternate, and failure outcomes, candidate acceptance, observable verification, non-goals;
- context: current user journey, direct dependencies, contracts/invariants, neighboring scenarios, repository conventions, integration boundaries;
- user scenarios: primary, alternate, empty, error, permission/auth, retry/recovery, before/after transition;
- product precedents: similar behavior, established terminology, implementation and testing precedents, reusable pattern, intentional divergence.

Missing, duplicate, unknown, or reordered criteria fail validation. `covered`, `partial`, and `not_applicable` coverage require specific evidence; N/A also requires a conclusion. Unknown coverage requires a distinct actionable unknown. `discover-outcome` and `discover-user-scenarios` require at least two observable candidate criteria unless top-level applicability is `not_applicable`; discovery records evidence and verification rather than selecting an implementation solution. Collections are capped at 12, ordinary text at 2 KiB, reports at 20 KiB UTF-8, and five-report fan-in at 100 KiB.

The role calls `pipeline_discovery_submit`; an unexposed controller token binds the tool closure to the concrete registered node. The host records payload during the turn and consumes/validates it only after that same session settles. Validated final-text JSON remains a compatibility fallback. Parsed reports plus role/session/attempt/submission provenance enter Sol context as untrusted objects rather than JSON strings embedded inside JSON. Correction accounting is independent per concrete session: rejected settled turns one through three continue that same session without cancelling other tracks, while rejection four fails the run and cancels remaining sessions. Provider failure/cancellation may fail immediately. A replacement is allowed only when creation failed before a usable session existed. Pre-final audit retry remains bounded and root-controlled; the final audit segment remains controller-owned and fail-closed.

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
  → controller-owned reusable five-contributor Luna final audit segment
  → Sol resolves synthesis and revalidates once
  → factual plan completion
```

The root remains unable to use shell/edit/write or delegated mutation tools. It writes only through the validated plan artifact tool and reads bounded plan/Git evidence. Earlier discovery, artifact, audit, retry, and remediation behavior remains intact.

### Standalone audit pipeline

```text
Deferred persistent Luna/medium synthesis root
  ├─ four controller-owned read-only Luna/medium static tracks in parallel
  ├─ one controller-owned Luna/medium audit-executor contributor with bash
  ├─ first valid report activates root synthesis
  ├─ later reports are serialized/batched into that same session
  └─ strict factual structured audit handoff
```

No pipeline agent intentionally mutates source/config, remediates findings, makes readiness claims, or decides Git actions. Executor verification may create test/build/cache artifacts; those effects are observed and reported rather than rolled back.

## Commit permission and audit evidence

`pipeline_run` accepts optional `git_commit`, defaulting to false. It is valid for `feature-pipeline` and `small-feature-pipeline`; `plan-pipeline` and `audit-pipeline` reject true rather than ignoring it. The value is an explicit host contract, never inferred from task text. When enabled for feature, only the persistent Sol root may create ordinary commits in the supplied working directory on its already-current branch. When enabled for small-feature, only the persistent `implement-small-feature` Luna session has that authority. Feature discovery, both audit waves, audit-executor, synthesis, the small-feature coordinator/auditors, and every other pipeline child remain unable and forbidden to commit. False or omission leaves implementation changes uncommitted even when task prose requests a commit.

The authority matrix is structured by definition and role rather than inherited through generic child policy. Opt-in does not alter the mandatory implementation-worktree admission contract and adds no clean-tree, target-branch, or particular branch-name requirement; the caller owns workspace preparation, branch selection, and conflict isolation. Even when enabled, push, merge, rebase, reset/history rewriting, branch creation/switch/deletion, worktree creation/removal, and external delivery-state mutation remain prohibited.

Audit tracks receive reusable host-collected evidence captured with argument-array Git commands: base and current HEAD, branch/status, base ancestry, bounded base-to-head commit list, committed base-to-head diff, dirty HEAD-to-worktree diff, and combined base-to-worktree diff. Every bounded item identifies whether evidence is available, truncated, or unavailable. This evidence is injected into standalone and applicable feature, plan, and small-feature audits. Small-feature remediation stays in the same persistent implementer session and is not re-audited. Feature and small-feature completion append fresh host-collected final Git facts so the factual handoff distinguishes committed, dirty, and combined state without making a readiness or delivery decision.

## Tooling, inspection, and completion

Feature and plan roots receive `pipeline_audit_start`, a definition-specific tool that accepts only the bounded acceptance contract, assumptions, and check evidence. It starts the fixed shared segment and returns the six controller-owned agent IDs (five contributors plus synthesis) for normal run-scoped waiting/inspection. It is not a generic fan-in or workflow API. Pipeline children cannot call it.

`pipeline_check` and `pipeline_list` remain synchronous, nonblocking, and main-agent-only. Audit progress exposes only mode, phase, expected/accepted/pending/integrated counts, reducer idle/busy/finalized state, revision, and final-validation boolean. It never exposes prompts, thinking, tool arguments/results, raw reports, Git evidence, report provenance, session files, or session paths. Text and previews remain bounded.

`pipeline_complete` continues to emit facts rather than readiness. Standalone audit completion is controller-owned after strict final validation and includes the bounded structured final audit report. Feature and plan roots still call `pipeline_complete` after their own final resolution; feature completion augments Sol's report with fresh final host Git observations. The calling main agent owns readiness, remediation outside the standalone audit, and all branch/commit/push/PR decisions beyond the narrowly opted-in ordinary commits described above.
