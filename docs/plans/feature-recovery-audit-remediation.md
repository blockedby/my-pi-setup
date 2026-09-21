# Feature recovery — initial audit remediation

Status: original AUD-001, AUD-002 and AUD-003 independently closed. The later session-recovery slice has its own findings (IDs reused by that audit); do not conflate them with the original blockers. Broader twelve-item refactor is not fully accepted or installed.

## Session-recovery slice review

Initial run `session-recovery-slice-audit-f71dc923`, `audit-report` revision 1, digest `0dc698c75591ba7b69d5d035eb9c47cf925400b98221e60d9a2d8f126c6b2daf`. Original complete finding objects are retained in that immutable artifact.

- **Session AUD-001: creating-session admission alleged to leak candidate lease.** Impact 3, confidence 96, static. Claim: replacement creation after host admission but before adapter registration loses the candidate identity, retaining authority and preventing a later admission. Expected closure: failed candidate authority revoked/drained, checkpoints/runtime retained, bounded next continuation recovers or fails closed. Parent counterevidence: factory callback already records candidate ID and lease synchronously; catch probes availability and revokes/records technical loss; next continuation retires/drains it. Astra sa-31 owns a real-Git construction-failure counterproof in controller tests; no production change made solely on this disputed claim.
- **Session AUD-002: 5-second drain test collides with harness timeout.** Impact 2, confidence 100, executed failure in selected and declared aggregate suites (698 passed, 1 failed). Parent gives this specific test an explicit 15-second test deadline, leaving the 5-second production bound unchanged. Fresh full runtime verification launched; aggregate rerun and bounded closure pending.

Closure `session-admission-counterproof-closure-0a3a6768`, `audit-report` revision 1, digest `ad6f81186ebb6259d00788b1839d3748f67d81c94f5053b9486b2e8a1f77aff1`: both session findings closed, `findings: []`, no unproven review checks. The executed construction-failure regression disproved session AUD-001; no production weakening was made. Session AUD-002's deadline fix passed independently. Declared aggregate: **700 Bun + 22 Vitest tests passed**, plus typecheck/format/lint/diff checks. Implementation acceptance passed. Execution envelope remains unproven solely because the read-only audit emitted no cleanup events, not a demonstrated product defect. Original graph/check/residual blockers remain closed. Remaining planner intervention and broader twelve-item acceptance are not implied by this scoped closure.

Initial audit: `feature-recovery-initial-audit-f4803f9e`, artifact `audit-report`, revision 1. Product identity: HEAD `8d35f5bcbca58a419d80a4223f226d9f68fede46` plus dirty worktree, digest `65385937d2faf3740b91566c1e45ce0dc2ed3a27da441488ef0d24b8a4b43b80`. Original finding objects remain in that immutable artifact and must accompany closure review.

## Blockers and closure targets

- **AUD-001 — Graph-wide exception stop blocks independent fork work.** Introduced; static evidence; impact 3, confidence 98. Fork catch sets global `launchingStopped`, affecting later unrelated siblings. Close by proving local exceptions block only their failed subtree/dependents while independent later work continues. Cancellation and explicit integrity/persistence failures must retain global authority. Owner: Astra sa-16, graph executor and its tests only.
- **AUD-002 — Revised required checks can replace failed obligations.** Introduced; test evidence; impact 3, confidence 100. Recipe/result replacement keyed only by check ID permits acceptance after a successful substitute for an original failed requirement. Close by retaining original required obligations and evidence until independently satisfied or explicitly superseded by authorized controller policy, not model recipe self-approval. No semantic command-string heuristic. Owner: Astra sa-17, task runtime and its tests only.
- **AUD-003 — Summary-only final review rejects explicitly retained cleanup residuals.** Introduced; static evidence; impact 3, confidence 94. Review receives recorded residuals but acceptance treats all dirty paths as meaningful. Close with narrowly scoped fingerprint-validated controller-known unchanged residual handling and tests rejecting altered residuals/unowned changes. First reconcile with the no-inherited-dirt contract; do not restore blanket exemptions. Same owner as AUD-002 because acceptance code overlaps.

## Remediation observations

- AUD-001 is reproduced by an actual nested allocation permission failure; cancellation regression passes. sa-16 retained the failing regression rather than suppressing all errors. Parent added `FeatureSubtreeOperationError` for trusted lifecycle classification: only explicit isolated worktree-allocation failures with intact shared ownership may be local; unknown, ownership and persistence exceptions remain fatal. sa-18 owns lifecycle classification/tests; sa-19 owns executor handling/tests, including sibling settlement before teardown.
- Parent independent runtime/freshness/session/dispatch run after AUD-002/AUD-003 remediation passed 69 tests, plus typecheck and lint. Parent lifecycle/runtime/real nested-join run passed 79 tests, typecheck and lint.
- sa-18 reports 31 lifecycle tests passing. sa-19 reports 37 executor tests passing, including actual allocation failure, cancellation, unknown-error lookalikes, ownership drift, persistence failure and sibling settlement. Executor now uses trusted `instanceof` classification and waits for sibling settlement. Parent launched a combined six-file regression run and full checks; independent closure review remains required.

- sa-17 reports AUD-002/AUD-003 regressions failed before changes and 47 tests passed after. Revised recipes receive additional required IDs rather than replacing original requirements. Acceptance exempts only controller-recorded fingerprint-validated residuals; staged/changed residuals and path-only exemptions remain rejected. Parent inspected the relevant code and launched runtime/freshness/session/dispatch verification; closure is not yet established. Evidence logs: `/tmp/audit-runtime-before.log` and `/tmp/audit-runtime-final.log`.

## First closure result

Closure run `feature-recovery-closure-audit-ca4ef52d`, `audit-report` revision 1, reviewed dirty digest `aada495f12be2410ed59504c1c6ee9c798300f997f64168f356b763e30d1f419`: AUD-001 and AUD-002 confirmed fixed. AUD-003 remains open specifically for unchanged controller-recorded **untracked** residuals; prior remediation/tests covered tracked residuals only. Do not infer readiness from the 186 passing parent integration tests or audit's 115 focused/683 full tests.

Astra sa-20 owns runtime/worktree residual recording and acceptance plus their tests for this remaining blocker. The fix must carry and validate fingerprints, never grant path-only dirty exemptions; parent owns any controller/graph propagation. Next closure is limited to AUD-003 and direct remediation regressions; AUD-001/002 retain their closed state.

## Final blocker closure evidence

- `residual-counterproof-closure-audit-e562a06b`, `audit-report` revision 1, dirty digest `e6ffc6931fda410a0eced003161e3dd27679de96967c9aa73e543e51acb53349`: `findings: []`, AUD-003 `closed`; AUD-001/AUD-002 retain their previous closed state.
- The intervening claim that pre-begin arbitrary dirt bypassed summary acceptance was disproved by the actual path (`accept` supplies an empty preparation baseline) and the retained `arbitrary-prebegin` real-graph regression. No production weakening was made; an optional test diagnostic type error was fixed.
- Independent executor: 42 graph tests passed; repository-declared `bun run test` passed 689 Bun tests plus 22 Vitest tests; typecheck, full format check, lint and diff checks passed. Bare `bun test` is not the aggregate runner: it incorrectly loads nested Vitest tests and failed. Use the declared script.
- Audit envelope remains `unproven`, not a global PASS: it includes broader-scope limitations, lack of cleanup events in a read-only audit, and non-executor tracks relying on executor verification. These are distinct from a confirmed unresolved product defect. Do not run more broad audits merely to change that envelope.
- No confirmed blocker remains in this review scope. Remaining graph intervention, workspace/API policy, managed toolchain provisioning and technical-loss readiness remain explicitly outside this closure; do not claim all twelve improvements complete.

## Verification and iteration

The independent audit ran 107 focused recovery tests, 103 controller/session/readiness/contract tests, the declared deterministic suite (670 Bun tests plus 22 nested Vitest tests), typecheck, format, lint and diff checks successfully. Passing suites did not rule out the three findings.

After remediation, the parent inspects changes, runs integrated offline regressions and repository checks, then launches a bounded closure audit with original blocker objects, remediation diff and touched invariants. Repeat only for confirmed residual blockers; do not start unrelated broad review or weaken acceptance to obtain a green verdict.

The audit's `audit-coverage` and `cleanup-policy` envelope entries are evidence limitations, not additional proven product defects. Technical session loss/revocation, cancellation interleavings, persistence-failure cleanup ordering and managed toolchain provisioning remain unproven or incomplete. A clean closure of these three findings does not alone complete all twelve improvements.

No commits, push, installation, runtime restart, provider-backed tests, or unrelated dirty-file cleanup are authorized by this remediation loop.

## Remaining twelve-item slice: integration verification

The session-loss slice was subsequently independently closed by `session-admission-counterproof-closure-0a3a6768`; no original/session blocker remains confirmed open. The final remaining slice adds accepted preparation-recipe propagation, clean owned-child recreation, bounded read-only planner escalation and safe unordered narrative normalization (see the implementation ledger's twelve-item map).

Initial audit `remaining-recovery-slice-audit-6bc265c1` was cancelled after aggregate verification exposed two graph regressions (797 passed, 2 failed). It produced no completed product audit and is not acceptance evidence. Parent reproduction found overbroad strict legacy-handoff gating: ordinary preparation artifacts were incorrectly treated as cleanup residuals, also changing ownership-detection timing. Legacy recreation now requires recorded residuals; explicit checkpoint gating remains intact. Both original failing tests remain unchanged. A new real-Git owned-child regression separately caught and fixed the missing legacy-commit trigger and clean-gate ordering; its baseline assertion was corrected to measure the additional probe rather than ignore finalization checks.

Fresh `bt-8` passed all 55 graph tests, typecheck, formatting, lint and whitespace checks. Aggregate verification `bt-9` passed 799 Bun + 22 Vitest tests and all static gates. Independent initial audit `verified-recovery-slice-audit-017a6a3b` (digest `48351830f1f91f58d1fc3a953fd1273be3d717f2258949a1a4a2059fefb727a8`) independently repeated the aggregate and static checks, plus 301 focused tests. It reported one confirmed blocker; implementation is not yet accepted.

### Remaining-slice AUD-001 (distinct from earlier audit IDs)

Original finding, retained for closure:

```json
{
  "id": "AUD-001",
  "title": "Planner consultation exceptions are downgraded to ordinary blocked task failure",
  "scenario": "During an active build, a stalled task invokes planner recovery and the canonical planner session's send, wait, JSON parsing, or decision parsing throws or reports an error while the run remains active.",
  "expected": "Consultation exceptions must remain fatal and preserve fatal authority and persistence semantics rather than becoming a normal planner blocked outcome.",
  "actual": "controller.ts catches consultation exceptions, synthesizes and persists a valid action: blocked decision, and returns it. The executor converts that decision into runtime.fail, following the ordinary local-failure path instead of propagating the exception as fatal.",
  "affectedPaths": [
    "extensions/pipelines/controller.ts",
    "extensions/pipelines/feature-graph-executor.ts"
  ],
  "relationship": "introduced",
  "evidenceType": "static",
  "evidence": "Validated static evidence places the combined send/wait/settlement/parse operations in the controller catch, which constructs and validates a synthetic blocked decision before persisting and returning it. The graph executor treats blocked as an ordinary failed task. The executor independently passed targeted and aggregate tests, but no test demonstrated fatal handling for an injected planner-session or parsing exception; the reliability and logic-invariants tracks independently identified the same reachable invariant violation.",
  "impact": 3,
  "confidence": 98,
  "minimalNextAction": "Let non-cancellation consultation/session/parse exceptions propagate after request persistence, retaining fatal abort/incomplete-evidence handling; reserve synthetic blocked results for explicit valid blocked decisions and add a regression for live planner send, wait, or parse failure.",
  "sourceRoles": [
    "audit-reliability-regressions",
    "audit-logic-invariants",
    "audit-executor"
  ],
  "scope": "initial",
  "scopeReference": "task"
}
```

Remediation assigned exclusively to controller implementation/tests: preserve explicit valid blocked advice, but propagate transport/settlement/parsing failures with fatal authority and fence queued consultation; retain request evidence and test cancellation/persistence boundaries. Parent will verify and request closure only for this finding and directly touched invariants. Audit unproven checks for injected persistence/cancellation and full lifecycle cleanup-event traces are evidence limitations, not additional promoted product defects.

Remediation delivered in `controller.ts` and `controller.test.ts`: removed synthetic blocked fallback, stored the first fatal consultation error, synchronously aborted feature recovery before releasing the serialized queue, and rethrew the original error after graph settlement. Request/decision persistence failures still mark evidence incomplete; explicit valid blocked decisions remain ordinary outcomes. The worker passed 70 controller tests and static gates. Invalid JSON and invalid decision regressions fail when old behavior is restored. New tests cover send/settlement/parsing errors, request/decision persistence failure, cancellation, absence of fabricated decisions and no acceptance. Direct wait rejection and a deterministically forced queued-cancellation interleaving were not separately executed; no claim of exhaustive interleavings. Parent inspected the remediation diff (`/tmp/planner-fatal-controller.diff`, `/tmp/planner-fatal-tests.diff`) and launched full verification `bt-10`. Final closure `planner-fatal-authority-closure-1c99ff05` independently closed AUD-001 with no findings, unresolved conflicts or unproven checks. Reviewed product digest: `6d1e89bcc30df44314b5c5b2e4662c455be6819dc87d3760d6cc27eda5c925c0`. Implementation acceptance passed. Parent `bt-10` and closure executor both verified 805 Bun + 22 Vitest tests and typecheck/format/lint/diff; closure additionally ran all 70 controller tests. No confirmed product blocker remains. The audit execution envelope remains unproven only for absent read-only-audit cleanup events, not a product cleanup failure. Source acceptance does not authorize or imply installation, provider testing or runtime rollout.
