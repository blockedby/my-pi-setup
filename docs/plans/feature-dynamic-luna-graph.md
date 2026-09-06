# Dynamic Luna feature execution — implementation tasks

Source: `pipi-feature-pipeline-dynamic-luna-architecture.html`, supplied on 2026-09-06. Scope: replace the Best-of-3 implementation segment of `feature-pipeline`; preserve discovery and independent audit behavior.

| Task | Deliverable | Depends on | Verification |
| --- | --- | --- | --- |
| 1. Planning contracts | Strict bounded candidate and canonical plans; structured submissions; safe paths and semantic references | — | Schema and semantic contract tests |
| 2. Graph compiler | Validated execution graph compiled deterministically to Task, Sequence and Fork | 1 | Linear, nested, multiple-root/sink, cyclic and cross-branch graph tests |
| 3. Branch and commit lifecycle | Caller-selected child worktrees; preparation; owned provisional/amended commits; deterministic cherry-picks; retained failure diagnostics | — | Disposable real-Git fixtures, path and drift tests |
| 4. Task execution | Capsules, declared checks, finalization, four attempts, conflicts and join repair | 2, 3 | State transitions, executed checks, retry and cancellation tests |
| 5. Controller and sessions | Two independent Sol plans; one persistent Sol canonical/graph/review session; fresh Luna tasks; audit handoff and artifacts | 1, 2, 4 | Controller and tool-boundary integration tests |
| 6. Inspection and UI | Plan/build/review stages, task and branch progress, details and diagnostic warnings | 4, 5 | Snapshot projections and dashboard interaction tests |
| 7. Documentation and verification | Current design and usage, durable operation record, full checks, independent initial/closure review | 1–6 | Declared checks, deterministic suite, evidence-driven review |

Tasks 1–2, 3–4, and 5 are assigned to three Sol implementation agents. The main agent owns task 6–7 and integration. Implementation uses a dedicated linked worktree and branch, leaving the existing working copy's Pipi upgrade changes intact.

Acceptance follows all 24 architecture acceptance criteria in the supplied specification. In particular, no unvalidated commit may join another branch, one task produces at most one logical commit, direct-subagent quotas do not schedule the graph, and final review uses the original Sol session before independent audit.
