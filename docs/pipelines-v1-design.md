# Hardcoded pipelines — design and runtime contract

_Status: implemented design record. The public surface is intentionally four bounded definitions, not a generic workflow API._

## Public definitions and ownership

`pipeline_run` accepts a self-contained `task`, caller-selected `working_dir`, and one of four hardcoded definitions:

- `feature-pipeline`: five-track Luna discovery, two independent Astra/low candidate plans, one persistent Astra/low canonical planner and final reviewer, a controller-validated graph of fresh Luna/high implementation tasks, deterministic branch joins, and the existing independent audit/remediation flow;
- `small-feature-pipeline`: read-only Luna/medium coordinator, one persistent Luna implementer, four parallel Luna auditors, and one same-session implementer remediation pass;
- `plan-pipeline`: controller-owned six-track Luna/medium evidence discovery, one Luna/xHIGH free-form synthesis session, and factual completion with optional caller-selected in-workspace output;
- `audit-pipeline`: four isolated read-only Luna/medium static audit tracks, one trusted-workspace Luna/medium audit-executor contributor, and one persistent Luna/medium incremental synthesis root, with no Sol, Terra, remediation, readiness decision, or Git decision.

Every launch requires an unchanged `pipeline_name` containing exactly three to five lowercase kebab-case words, beginning with a letter, with a maximum length of 64 characters. Input is not trimmed or normalized. The controller appends eight lowercase hexadecimal characters from secure host randomness and uses the resulting canonical value (for example, `replace-heavy-plan-pipeline-f82091ba`) as the sole public run ID for maps, scopes, inspection, cancellation, UI, session titles, and handoffs. Token generation and the eight-attempt admission budget are injectable for deterministic tests; a live ID collision retries and exhaustion fails before run state exists.

Omission still selects `feature-pipeline`. Unknown names fail closed. Callers cannot select arbitrary roles, edges, models, or Git refs. Feature callers explicitly supply ordered child-worktree preparation commands; the accepted Astra graph supplies sandboxed verification commands. Terra constants, model profile, direct-subagent quotas, and `terra-audit` remain available for explicit future/manual escalation, but no automatic pipeline route uses Terra.

Before invoking `feature-pipeline` or `small-feature-pipeline`, the calling main agent creates a dedicated linked Git worktree on its own local branch, runs repository-declared preparation there, and passes the exact worktree root as `working_dir`. Admission occurs before run state or sessions and rejects primary, non-Git, bare, detached, unregistered, non-root, and branch-conflicting paths. `feature-pipeline` additionally requires a clean stable HEAD, explicit `git_commit: true`, and Linux bubblewrap before its controller admits a run-scoped feature namespace. `small-feature-pipeline` retains optional commit permission and caller-owned preparation without the feature-specific clean/bubblewrap/internal-worktree lifecycle. Plan and audit retain their workspace policy.

Feature requires an absolute, existing `worktree_root` plus an explicit `worktree_prepare` array (possibly empty). The integration branch is the caller-prepared `working_dir`. Child branches use `pipi-feature/<canonical-id>/branch-<number>-<first-task-slug>` and directories beneath `<worktree_root>/<canonical-id>/`. The controller checks namespace ownership before mutation and never adopts retained state. Each integration worktree admits one active feature run until its terminal handoff, and its captured branch and HEAD are rechecked after planning. Linear tasks reuse their branch; a fork allocates child branches. Joined child directories are removed best-effort, refs remain until successful full completion, and failure/cancellation preserve useful diagnostic state. Successful cleanup also removes scratch for deleted child worktrees only when this process created it and the recorded directory identities and canonical ancestry still match. Live caller workspaces, pre-existing scratch, redirected paths and unrelated sibling data are never reclaimed by that cleanup.

Pipeline graphs predeclare their roots and children and therefore do not consume, inherit, queue on, or enforce direct-subagent capacity quotas. Multiple runs may execute concurrently. Feature runs are isolated by their hard-required dedicated linked caller worktree plus controller-owned temporary worktrees; small-feature uses its required caller worktree, while plan/audit retain caller-owned workspace-conflict policy. Runs and child sessions are in-memory and session-scoped and are cancelled/disposed on shutdown, reload, switch, or fork.

## Per-stage wallclock limits

`pipeline_run.wallclock_limit` is optional and accepts only a caller-selected canonical integer duration with one unit (`30s`, `5m`, or `2h`). Omission disables caller-selected per-stage wallclock timing; no agent, prompt, or controller chooses a general stage budget. Explicit values are inclusive from 30 seconds through 24 hours. The public extension validates the syntax and range before constructing controller state, and the controller repeats admission validation before any run ID, session, worktree, or feature lifecycle allocation. The value is normalized to milliseconds internally and is not inferred from task text.

The controller owns one monotonic budget for each reachable asynchronous stage. The initial budget starts at admitted run insertion before asynchronous initialization; a later budget starts exactly when the controller enters that stage. Feature retains timing for discovery and audit stages; the revised `plan`, `build`, and `review` segment adds no task, branch, planning, retry, or join deadlines; small-feature times `build`, `final-audit`, and `final-resolve`; plan times `discover` and `synthesize`; standalone audit times `audit`. Plan `complete` remains an untimed atomic transition. A stage's retries, corrections, replacements, fan-in, root readiness, and remediation share its original epoch and deadline.

The former feature candidate steering timers no longer participate in the dynamic graph. Shared wallclock parsing, scheduling, warnings, limitation state, status projections and tests remain available to the surrounding pipeline definitions and unchanged timed stages.

At exactly 80% of a stage budget, the controller records warning state and signals each active current-stage session once. A deferred current-stage session receives one pending warning through its bootstrap prompt, and a session created after the boundary receives one immediate warning if it belongs to the current stage. Future-stage sessions remain dormant. Stage and epoch guards make reordered or stale scheduler callbacks inert. Enforcement and projections use an injected monotonic clock/scheduler; civil `startedAt` and `finishedAt` values are display metadata only.

At monotonic `now >= deadline`, the first synchronous terminal claim wins. If no valid completion, failure, or cancellation claim has won, the controller settles the run as the distinct `limited` status, freezes pumps and new work, captures validated progress and bounded best-available output, and delivers one limitation handoff. Cooperative `pipeline_execution_finish` is a session-bound terminating tool available to pipeline session kinds. Its optional summary/output is bounded provenance only: it cannot satisfy a typed report, fan-in, correction, retry, replacement, completion, or readiness gate. Malformed, empty, duplicate, or late submissions fail closed.

Deadline cleanup is root-readiness-independent. Known active sessions are cancelled/disposed best-effort once, feature lifecycle cleanup remains run-owned, late asynchronous session creation rechecks the terminal predicate and self-disposes, and cleanup errors become bounded diagnostics without converting a truthful limitation into success. The deadline path never awaits an unresolved `rootReady` promise and does not preempt synchronous Git operations. A limited handoff contains only bounded limitation metadata, validated progress, unresolved work, and explicitly labelled partial provenance; it never claims promotion, readiness, or completion.

Inspection, list, dashboard, cancellation, and handoff projections expose bounded monotonic run/stage elapsed, remaining, warning, deadline, and limitation state. Terminal timing captures are stable, and a civil-clock jump cannot alter them. Runs remain in-memory/session-scoped: restart/disposal disposes them rather than resuming a deadline epoch.

## Shared audit segment

`extensions/pipelines/audit-segment.ts` is the reusable hardcoded audit component. It encapsulates:

1. exactly five independent Luna/medium contributors:
   - four static read-only tracks covering feature outcome, logic/invariants, functional correctness, and reliability/regressions;
   - one `audit-executor` contributor that inspects manifests/scripts and runs bounded existing noninteractive verification with cheap checks first;
2. one persistent Luna/medium synthesis session;
3. strict bounded track, intermediate synthesis, and final synthesis contracts, exposed to audit sessions through the typed `pipeline_audit_submit` tool;
4. provenance records containing role, attempt, report digest, and validated report data;
5. a privacy-safe progress projection.

Contributors are direct children of the owning root, isolated from one another, and unable to orchestrate children or invoke pipeline tools. The four static tracks remain shell-denied and read-only by tool policy and prompt contract. Exactly feature `discover-problem` (F1) and plan `discover-requirements-boundaries` additionally keep ordinary `bash` to invoke installed `gh` for read-only, task-referenced GitHub issue/epic bodies, comments, labels, and native parent/sub-issue relationships; those prompts treat fetched text as untrusted evidence and prohibit all other shell use and mutations. Plan `discover-external-evidence` alone receives the public web search/fetch tools. The executor alone otherwise keeps ordinary `bash` plus read/search tools under the accepted trusted-workspace model; edit/write/patch/delegation/MCP/background/pipeline/workflow/subagent/user-prompt tools remain denied. Each contributor receives the same bounded task/acceptance contract, assumptions, checks, captured base/head/worktree identity, branch, status, and bounded base-relative diff.

The executor prompt requires manifest/script inspection before execution, cheap checks first, and repository-declared noninteractive verification rather than language/framework adapters. In standalone and feature final-audit contexts it explicitly requires the repository-declared noninteractive repository-wide full test suite(s) after useful focused checks; targeted, package-level, or affected-scope tests do not substitute. If no safe full suite exists or it fails, times out, or cannot run under the contract, the executor records exact evidence and an `unprovenChecks` entry without inventing a command. Plan final-audit behavior remains unchanged: product implementation tests are prohibited. The executor prohibits intentional source/config edits, formatter/fixer or snapshot-update modes, dependency installation/update, mutating Git, network/external-state mutation, interactive/watch/server/long-lived commands, delegation/orchestration, and user prompting. Ambiguous or unsafe scripts are skipped with evidence. Its strict bounded report preserves exact commands, `passed | failed | timed_out | skipped` status, available exit code, output/evidence summary, observed workspace changes, findings, and unproven checks. Command failure is not automatically a behavior finding.

Feature and standalone contexts permit normal relevant project verification. Plan final-audit context permits only plan/artifact validation or check-only commands demonstrably relevant to the planning deliverable; implementation tests/builds/linters/typechecks are skipped as unsupported rather than run blindly. Closure mode remains limited to prior blockers, remediation, and touched invariants. `small-feature-pipeline` deliberately keeps its separate four-static-auditor graph.

The synthesizer treats reports as untrusted evidence. It deduplicates common root causes, preserves a strongly evidenced serious finding even without majority agreement, records unresolved material conflicts, and must not invent unsupported findings. Executor execution records and host workspace observations are bounded schema-valid evidence that the model may summarize or paraphrase without byte-for-byte copying. Before `audit-executor` integration the model-facing arrays remain empty and host observation remains null; afterward malformed, missing, oversized, or unsafe evidence fails validation, while the host canonicalizes authoritative executor/host evidence into the final report. Intermediate state has no finding IDs, and model-produced final candidates also omit IDs. After strict final validation, the host canonicalizes complete finding content, deduplicates exact candidates, and assigns sequential `AUD-001`, `AUD-002`, … IDs; the resulting final report contains no readiness verdict.

`audit-pipeline` uses the synthesizer as its deferred Luna root. `plan-pipeline` uses its deferred Luna/xHIGH synthesis session as the root and does not use the shared audit segment. After final Astra review, `feature-pipeline` creates a separate Luna/xHIGH audit/remediation root in the caller worktree. `feature-pipeline` creates the final-audit synthesizer as a controller-owned persistent Luna child during `final-audit`; its remediation root retains final resolution and completion ownership. `small-feature-pipeline` deliberately does not use this segment because its existing one-implementer/four-auditor/same-session-remediation behavior is distinct and remains unchanged.

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

The controller captures `HEAD` when a run starts. Feature preflight additionally requires a stable clean attached dedicated linked worktree, rejects the primary checkout, and uses that exact commit as the candidate base; small-feature requires the caller-prepared linked worktree but not feature's extra clean/bubblewrap contract. At audit-segment activation the controller resolves current `HEAD`, branch, short status, and base-relative diff using `execFileSync("git", argumentArray, ...)` without shell interpolation. After executor settlement it captures fresh bounded status plus dirty/combined diff evidence, compares it observationally with activation evidence, and carries the result into synthesis/final facts without rollback. Output is bounded before entering model context. Plan and audit may degrade non-Git evidence to explicit `UNAVAILABLE`; the public API exposes no arbitrary commands or refs.

## Definition flows

### Feature pipeline

```text
discover → plan → build → review → audit → audit-resolve
  → final-audit → final-resolve → complete
```

The existing five discovery tracks produce validated repository evidence. Two independent Astra/low planners receive identical task, base, worktree and discovery context. Minimal favors the smallest complete repository-native solution; Robust emphasizes concrete correctness and recovery risks. Both must validate before synthesis. Neither sees the other's proposal.

One persistent Astra/low session synthesizes the canonical plan, then constructs the execution graph in a separate turn. It stays read-only until the entire graph joins, then gains mutation tools for final review in the original integration worktree. Candidate plans, canonical plan and graph use strict bounded TypeBox reports with semantic ID, reference and path validation and at most three same-session corrections after the initial response. Model reports are untrusted data. The accepted canonical artifact is authoritative without a separate digest/freeze protocol.

The controller validates acyclicity and structured series-parallel dependencies, then compiles the graph to recursive Task, Sequence and Fork blocks before launching implementation. Multiple roots, terminal branches and nested forks are supported; cross-branch dependencies before a common join are rejected. Task IDs determine stable ordering. Overlapping expected `writePaths` do not invalidate a graph or restrict the actual safe commit set.

Every task receives a detailed capsule containing its goal, conventions, discovery evidence, precedents, invariants, instructions, implementation sketch, acceptance mappings and checks. Host context supplies branch/HEAD/worktree, integrated dependency commits and summaries, following tasks, residual paths, attempt and prior failure evidence. Every task starts a fresh Luna/high session. A task has four attempts total; later attempts continue its existing branch, dirty work and provisional commit. Preparation failures stop that branch immediately without consuming model attempts. Before its first ordinary task, each branch must pass the accepted baseline checks in the execution environment; a required failure or tracked-file mutation stops launch with the check evidence rather than starting repair agents against an unready environment. Explicit join/conflict repair sessions remain eligible to repair integration failures. Independent branches continue during recoverable retries. A terminal failure stops new task sessions, including retries; an in-flight sibling may still finalize normally. If it settles without validation, its factual attempt, checks and provisional commit are retained and its authority closes without a synthetic cancellation or another worker launch.

The caller prepares `working_dir` before launch. New fork worktrees run `worktree_prepare` once before their first task, require unchanged tracked files and an empty index, and record untracked/ignored environment artifacts. Before tasks, forks and joins the controller verifies the expected branch, HEAD and tracked/index state. Only controller-owned Git operations may create branches, worktrees, commits, amendments or cherry-picks. Shell commands run through the assigned-worktree sandbox without network or Git-metadata access; dependency assets needed by child preparation must already be available offline. Check `cwd` values reject absolute paths, traversal and symlink escapes. Graph checks are executable verification, not dependency installation or prose/manual acceptance gates. The exact declared command `git diff --check` is a controller-owned read-only exception, evaluated against the task/review base so provisional commits do not hide whitespace errors. It disables executable Git helpers (filters, external diff, textconv, fsmonitor and hooks); compound shell commands do not gain this exception. Check output is drained with bounded retained diagnostics, preserving Git's exit code even for large whitespace reports. Truncated filter-configuration discovery fails closed. Cancellation terminates the owned process group and escalates to kill if necessary.

Task tools are `pipeline_task_diff({offset?,fingerprint?})`, `pipeline_task_check({checkId})` and `pipeline_task_finalize({commitPaths,summary})`. Workers do not receive the unrelated `pipeline_execution_finish` tool. When a worker settles after rejected finalization, its specific check failure remains the retry reason instead of being replaced by a generic missing-finalization message. The diff distinguishes base-to-HEAD, dirty/staged state, new files, environment baseline, residuals, provisional commit and previous checks. The controller processes the full diff without a fixed whole-output buffer limit and returns bounded pages with an exact full byte count and fingerprint. A continuation uses `nextOffset` and that fingerprint; if the diff changes, the caller restarts from the first page. Every part remains retrievable, including the tail of large lockfile or generated-code changes. Finalization validates and stages exact safe changed paths, creates one provisional task commit, attempts bounded cleanup, then runs required baseline plus task checks. Later finalization amends only the owned provisional HEAD. Empty paths rerun checks or produce a verified `satisfied_without_changes` result without an empty commit; meaningful tracked changes cannot be silently discarded. Checks that modify tracked files leave the task provisional. Cleanup warnings propagate without retroactively invalidating verified work. Recorded tracked residuals may continue to the next task only while their index and worktree fingerprints remain unchanged; new drift is rejected. Final review receives only the integration branch's recorded residual authority, while diagnostics retain the history from all branches.

Fork branches execute immediately without direct-subagent quota accounting. Joins wait for all validated child results, order children by first task ID, and sequentially cherry-pick their commits oldest-first with source provenance. Source and integrated SHAs are recorded. A dedicated Luna/high conflict resolver continues the active cherry-pick through controller finalization. Every join reruns baseline checks; cancellation or an exception during join verification publishes a terminal join status and bounded diagnostic before propagation, rather than leaving a stale checking row. A semantic failure creates one internal Luna/high join-repair task with the same four-attempt policy and one logical repair commit. Parents resume only after integration verifies.

The original Astra/low session reviews the fully joined result against its canonical plan, using task summaries, commit mappings, checks, cleanup evidence and the base-relative diff. It may repair directly with one provisional/amended review commit or finalize without changes. Required review checks gate audit handoff. There is no second repair graph, selection worktree, winner, whole-file augmentation or promotion step.

Independent audit receives canonical acceptance criteria, contracts, assumptions/risks, final Git evidence, verified checks and the final Astra review summary. Candidate plans, execution graph, Luna transcripts/retry history and conflict discussions are withheld. The existing audit/remediation/final-audit/final-resolution flow continues against `working_dir`. Exact per-finding resolution records remain required for completion.

Artifacts are persisted outside the repository beneath `~/.pipi/agent/pipelines/<run-id>/`: candidate-minimal.json, candidate-robust.json, canonical-plan.json, execution-graph.json, task-results.json, sol-review.json and run-summary.json. They remain diagnostic records after success and do not enable resume. The dashboard exposes planning, graph tasks, attempts, branch/worktree/commit state, joins, repairs, review and cleanup warnings; task inspection includes the capsule, checks, summary and session attempts.

Cancellation and shutdown stop launches, cancel sessions, preserve completed and provisional work and retain failure refs. Successful child joins remove worktree directories best-effort; successful full completion removes remaining run-owned temporary refs and worktrees. Cleanup never deletes paths behind stale Git metadata and never touches resources not owned by the run.

The source specification is decomposed into [implementation tasks](plans/feature-dynamic-luna-graph.md).

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
Controller-owned six parallel Luna/medium evidence tracks
  → complete validated fan-in
  → one deferred Luna/xHIGH free-form plan synthesis session
  → factual completion
```

The six discovery sessions are bound to requirements/boundaries, architecture/responsibilities, contracts/invariants, reuse/simplicity, quality/operations, and external evidence. Each submits one strict role-bound evidence report; malformed reports receive bounded same-session correction and incomplete fan-in cannot advance. Only requirements discovery can use the existing read-only installed-`gh` exception, and only external evidence can use web search/fetch. Discovery is otherwise read-only.

The synthesis root receives the original task plus all validated reports and provenance. It can inspect local evidence with `read`, `fd`, and `rg`, and has only the session-bound `pipeline_plan_submit` terminating tool. It has no shell, generic write, delegation, workflow, pipeline, audit, or completion tools. Its accepted Markdown is opaque free-form text: no structural task, heading, wave, test-vocabulary, audit, or readiness contract applies.

`plan_path` is explicit for every plan invocation. `null` writes nothing and returns the complete accepted plan in the terminal handoff. A string is resolved relative to `working_dir` (or accepted as an absolute path only when contained there), rejects traversal, outside paths, and symlink escapes, and is written atomically by the controller. Existing regular files may be replaced; unsafe destinations and write failures fail closed. The handoff and file use the same accepted bytes. Inspection exposes only bounded previews and factual path/count metadata. Plan does not invoke the shared audit segment or alter feature, small-feature, or standalone audit graphs.

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

`git_commit` remains a public boolean but has definition-specific semantics. Both implementation pipelines first require the caller-prepared linked worktree above. `feature-pipeline` additionally hard-requires explicit true; false or omission is rejected before discovery and before temporary Git state. `small-feature-pipeline` keeps optional false-defaulting permission for only its persistent implementer. `plan-pipeline` and `audit-pipeline` reject true. The value is authoritative and never inferred from task text.

Feature true authorizes controller-created task branches/worktrees, provisional commits and amendments, deterministic cherry-pick integration into the caller feature branch, conflict continuation and run-owned cleanup. Task and planning agents never manage Git directly. Discovery and audit roles cannot commit. No definition gains push, external delivery merge, unrelated history rewrite, deployment or external-state authority. Failed-run refs remain diagnostic; successful-run temporary refs are removed at full completion.

Audit tracks receive reusable host-collected evidence captured with argument-array Git commands: base and current HEAD, branch/status, base ancestry, bounded base-to-head commit list, committed base-to-head diff, dirty HEAD-to-worktree diff, and combined base-to-worktree diff. Every bounded item identifies whether evidence is available, truncated, or unavailable. This evidence is injected into standalone and applicable feature, plan, and small-feature audits. Small-feature remediation stays in the same persistent implementer session and is not re-audited. Feature and small-feature completion append fresh host-collected final Git facts so the factual handoff distinguishes committed, dirty, and combined state without making a readiness or delivery decision.

## Tooling, inspection, and completion

The feature post-review remediation root receives `pipeline_audit_start`, a definition-specific tool that accepts only the bounded acceptance contract, assumptions, and check evidence. It starts the fixed shared segment and returns the six controller-owned agent IDs (five contributors plus synthesis) for normal run-scoped waiting/inspection. It is not a generic fan-in or workflow API. Pipeline children cannot call it. Plan synthesis instead uses its session-bound plan submission and never receives this audit tool.

`pipeline_cancel`, `pipeline_check`, and `pipeline_list` are main-agent-only. Cancellation accepts a bounded non-empty unique run-ID list, processes every ID in caller order through the controller's whole-run cancellation path, waits for an in-flight initial root spawn before cancelling it and delivering, coalesces concurrent whole-run/root cancellation, settles and disposes the root session once even when interruption rejects, preserves feature lifecycle cleanup and exactly-once factual handoff behavior, records a bounded root-interruption failure in that handoff, and returns bounded per-ID `cancelled`, `already-settled`, `unknown`, or `failed` outcomes without exposing child/session controls. Check/list remain synchronous and nonblocking. Audit progress exposes only mode, phase, expected/accepted/pending/integrated counts, reducer idle/busy/finalized state, revision, and final-validation boolean. Inspection never exposes prompts, thinking, tool arguments/results, raw reports, Git evidence, report provenance, session files, or session paths. Text and previews remain bounded.

`pipeline_complete` continues to emit facts rather than readiness. Standalone audit completion is controller-owned after strict final validation and includes the bounded structured final audit report. Feature roots still call `pipeline_complete` after their own final resolution; the controller explicitly injects the validated structured final audit report into the final-resolve wait/check result rather than relying on synthesis `finalText`, requires exact structured per-finding resolution records, and augments feature completion with fresh final host Git observations. Plan completion is controller-owned after the accepted free-form plan and optional atomic output write, and its handoff includes the complete plan text plus factual path metadata. The calling main agent owns readiness, remediation outside the standalone audit, and all branch/commit/push/PR decisions beyond the narrowly opted-in ordinary commits described above.
