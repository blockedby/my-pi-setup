# Pipeline evidence implementation progress

_Status: implementation, deterministic verification, blocker closure, and disposable live smoke passed. Source delivery and global rollout remain pending._

## Current conclusion

The implementation now has controller-owned evidence contracts, a revisioned artifact store, scoped readers, source identity, cleanup records, check-input deduplication, and separate acceptance reporting. These are delivered mechanisms, not proof that every run will produce complete evidence.

Fresh verification passed 636 deterministic tests and a live Astra/Luna smoke on SDK 0.85.1 with both acceptance sections passed. See [the durable verification record](pipeline-evidence-live-verification.md). Global rollout remains separate. No runtime reload, durable session resume, crash reconciliation, or universal streamed-JSONL claim is made.

## Scope status

| Item | Actual delivered mechanism | State and remaining gap |
| --- | --- | --- |
| 01 | Controller event provenance, requested/selected model metadata, session/attempt/turn/submission links, and separate immutable reviewed/final source identities. | Implemented in source; identity capture fails closed when it cannot prove a stable scope. Closure and live-provider verification passed. |
| 02 | Agent-tree turn observations plus feature graph fork/branch/join events and per-fork controller task-turn interval reduction. | Implemented in source. It proves controller-observed intervals only, not provider-side computation; deterministic timing checks and observed live overlap passed. |
| 03 | Cleanup intent/outcome records with ownership, operation status, disposition, reason, and expected identity, routed through the controller journal. | Implemented as observational instrumentation. Existing ownership and retention policy is unchanged; crash gaps without an outcome still need reconciliation/verification and are not success. |
| 04 | Schema-v2 `RunEvent`, ordered journal persistence, lifecycle/submission/correction/error events, task check invocation IDs, and retained check history. | Implemented in source. Persistence failures are sticky `incomplete`; history and terminal-race regressions passed. |
| 05 | Strict V2 `implementationAcceptance` and `pipelineExecutionAcceptance` sections, with provisional/final assessment inputs and bounded compact handoff projection. | Implemented as reporting only, not a gate. Existing completion/final-audit gates remain authoritative; legacy payloads are unavailable rather than migrated to pass. |
| 06 | Role/phase-derived task tool contracts, allowed routes, structured denial codes, and no-bypass alternatives; artifact reader registration is also role-scoped. | Implemented in source and session wiring. No authority expansion is intended; policy-boundary tests and live execution passed. |
| 07 | In-flight check operation records keyed by task/attempt/check/input fingerprint; matching callers share one Promise, while completed checks are not cached. Controller `check_finished` events deduplicate by invocation ID. | Implemented in source. Workspace mutation starts a new input revision; focused concurrency and lock-release tests passed. |
| 08 | **User replacement preserved:** `pipeline_child_wait` has no per-tool timer; real cancellation and stage deadline/`limited` behavior remain. | Delivered in PR #93/source. No resumable WaitHandle or bounded external wait slice is claimed; cancellation/deadline regressions passed. |
| 09 | **User replacement preserved:** schema-valid illustrative submissions and existing correction budgets remain; no transport normalization was added. | Delivered in PR #93/source. Semantic rejection and same-session correction limits remain; normalization is not a delivered mechanism. |
| 10 | Revisioned snapshot store, manifest/revision history, UTF-8 paging, compact 16 KiB handoff references, terminal artifacts, and scoped `pipeline_artifact_read`. | Implemented in source and deterministic unit coverage is present. The controller writes immutable `event-N` JSON chunks; the store's separate `appendEvent` primitive cumulatively rewrites JSONL and is O(N²), so it is not controller streaming. Disk/reader/terminal regressions and live handoff acceptance passed. |

## Actual APIs and wiring

### Journal and event persistence

- `extensions/pipelines/run-evidence.ts` defines strict schema-v2 `RunEvent` records and a controller-only journal. The journal supplies authoritative run/controller identity, event UUIDs, sequence numbers, wall-clock timestamps, monotonic offsets, and bounded lifecycle facts.
- Persistence is ordered and cloned. A persistence error permanently marks the snapshot `incomplete`; an event after `seal()` is rejected and also marks evidence incomplete.
- `extensions/pipelines/controller.ts` persists each accepted event with `writeSnapshot({ artifactId: "event-<sequence>", schemaVersion: 2, value: event })`. These immutable single-event JSON chunks avoid rewriting cumulative history for every observation.
- `RunArtifactStore.appendEvent` exists for callers that want JSONL, but it reads the current artifact, appends a line, and writes a new complete revision. It is a cumulative O(N²) primitive and is not used by the controller. Evidence documentation must not call the whole implementation streamed JSONL.

### Artifact store and terminal outputs

`extensions/pipelines/run-artifacts.ts` stores immutable revisions below `~/.pipi/agent/pipelines/<run-id>/artifacts/` and atomically updates `manifest.json`. Manifest entries carry the artifact ID, canonical relative path, schema version, byte length, SHA-256, revision, and completeness; `artifact-index` is itself a revisioned immutable snapshot and prior revisions remain indexed. Reads require an artifact ID and revision, reject traversal/path links, verify integrity, and page at UTF-8 boundaries with a maximum requested page of 64 KiB.

The controller writes `pre-audit-evidence` provisionally, then terminal `run-evidence`, `concurrency`, `graph-timeline`, applicable task/review/audit artifacts, `acceptance`, `blockers`, `completion`, and `artifact-index` snapshots. The older feature-specific files are retained as compatibility diagnostics. Terminal write/seal failure returns evidence-incomplete handoff behavior and does not publish a complete index reference.

The public `pipeline_artifact_read` tool accepts a session-scoped `runId`; omitting `artifactId` returns a compact index that excludes `event-*` entries and inlines at most 64 current entries. Artifact reads require `revision` and support `cursor`/`maxBytes`. No filesystem path is accepted.

### Reader role access

Reader registration is deliberately narrow:

- the parent/main-agent global tool can read any known run held by that controller instance;
- `feature-pipeline` and `small-feature-pipeline` `pipeline-root` sessions receive the bounded reader through root tools;
- standalone `audit-synthesis` receives it through the session factory's `artifactTools` callback;
- ordinary discovery/planning roles, feature planners/finalizer/task workers, audit tracks/executor, and plan synthesis do not receive the reader.

The reader is an evidence route, not workspace/Git authority. Session shutdown/restart is not a reader migration or durable-resume mechanism.

### Review identity and acceptance

The code-review identity scope is exactly `tracked-and-staged-plus-nonignored-untracked-workspace`: tracked committed base-to-HEAD changes, staged changes, dirty tracked working-tree changes, and nonignored untracked regular-file path/mode/content. Ignored caches and dependencies are separate execution-environment state and do not alter this digest. Bounded path/file/diff/total limits and unsafe-path checks fail closed to `unavailable`.

The controller captures `reviewedIdentity` around audit activation and `finalIdentity` during terminalization. A changed source identity is not silently attributed to the old audit; the implementation assessment remains unproven because no automatic resolution-transfer model is implemented. Provider serving revision is optional metadata only.

The strict V2 acceptance envelope has independent implementation and pipeline-execution sections with `provisional | final` state and `passed | failed | unproven | not_applicable` criteria. The controller writes a provisional execution assessment before audit and a final assessment after terminal settlement/sealing. These are reporting projections, not completion/readiness gates: existing typed submissions, final-audit/final-resolution checks, `pipeline_complete`, and lifecycle status remain authoritative.

Legacy audit/acceptance payloads without both V2 sections are explicitly unavailable (`legacy_missing_sections` or `invalid_v2`), never normalized into a passed result. Existing legacy artifact files are preserved rather than rewritten or backfilled.

### Check and cleanup boundaries

- A check input revision combines HEAD, Git evidence fingerprints, relevant tracked/staged/untracked/conflict paths, and bounded readable content. The same active check ID, attempt, and unchanged fingerprint shares its in-flight Promise, including a finalize-owned check. Different checks, attempts, changed inputs, or active finalization remain blocked. Completed checks are not cached; `checkHistory` and invocation IDs retain executed history.
- Cleanup records intent before an operation and outcome afterward. Ownership, symlink/inode/ref guards, caller-owned retention, successful run-owned deletion, and failure/cancellation diagnostic retention are unchanged. A missing outcome is unproven; a failed/timed-out outcome is not represented as legitimate retention.
- Terminal delivery observes still-open journal sessions with a bounded `tree.wait` before `journal.seal()`. A timeout/error marks evidence incomplete; seal rejects late events and flushes queued writes before terminal artifacts and the exactly-once handoff are built. This is settlement-before-seal observation, not a guarantee of provider shutdown after the bounded observation.

## Migration, rollout, and limits

- Active runs use the code/contracts loaded by the process that created them. There is no runtime reload, durable session resume, or mid-stage format switch promise.
- The temporary live overlay verified SDK 0.85.1 compatibility without changing the installed runtime. Global rollout is pending. Existing legacy files are not rewritten.
- The #8 replacement remains no pipeline-child-wait timer, with cancellation and stage-deadline enforcement retained. The #9 replacement remains schema-valid examples plus existing correction budgets, with no normalization.
- Controller task-turn intervals do not prove provider-side parallel computation. Ignored dependency changes are intentionally outside code-review identity. Store/handoff byte limits, bounded history fields, reader registration, and session-scoped lifetime remain real limits.
- No implementation/planning pipeline, live provider run, dependency install, or smoke run was performed for this documentation pass.

## Verification status

- Source-level deterministic tests for the journal, artifact revisions/paging/integrity, identity scope, acceptance combinations/legacy handling, handoff budgeting, reader registration, cleanup evidence, execution assessment, and check deduplication are present in the working tree.
- Final TypeScript, formatting, exact submodule pin and diff checks passed.
- Full deterministic regression: **636 passed** (64 installer, 550 extension, 22 file-search).
- Independent closure fixed REV-001 and REV-002 with 66 focused tests; no residual findings in that scope.
- Live SDK 0.85.1 smoke completed in 13m10s; implementation and execution acceptance both passed, and the independent post-run fixture command passed 6/6 tests.
- Global rollout and automatic crash reconciliation are not claimed. Missing cleanup outcomes remain unproven.

## Implementation-plan basis

Source: `/home/kcnc/Downloads/pipeline-implementation-plan.html`, baseline `b69d2b7`. The plan's proposed names were checked against the loaded source; where the plan described a future `append-only JSONL`, resumable wait handle, or transport normalization, this record follows the actual implementation and the explicit #8/#9 user replacements instead.

Relevant loaded source: `extensions/pipelines/controller.ts`, `run-evidence.ts`, `run-artifacts.ts`, `run-acceptance.ts`, `run-evidence-handoff.ts`, `review-identity.ts`, `check-input-revision.ts`, `cleanup-evidence.ts`, `execution-evidence-assessment.ts`, `implementation-evidence-assessment.ts`, `session.ts`, `feature-task-runtime.ts`, and `extensions/shared/agent-tree/control.ts`.
