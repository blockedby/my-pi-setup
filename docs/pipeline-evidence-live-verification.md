# Pipeline evidence live verification

## Result

The disposable live-provider smoke passed on 2026-09-07 using the updated working-tree source and installed Pi SDK **0.85.1**, without installing it globally.

- Command: `bun scripts/smoke-pipeline-evidence.mjs --live --timeout-ms 2700000`
- Run: `smoke-pipeline-evidence-a1b2c3d4`
- Duration: 13 minutes 10 seconds.
- Lifecycle: `completed`.
- Implementation acceptance: `passed`.
- Pipeline execution acceptance: `passed`.
- Provider routing: `openai-codex/gpt-6-astra` and `openai-codex/gpt-5.6-luna`, through the installed SDK live provider path, not the deterministic adapter.
- Controller-observed independent task overlap: 34,513.123702 ms. This does not assert provider-side compute overlap.
- 22 sessions; all three implementation tasks completed on their first attempt. Earlier and final audit waves are separate controller roles/attempts.
- Three fixture commits; final HEAD `787237a8fc2852017a3e573e8747424ef6dc7362`.
- Post-run sandbox verification: `node --test test/fixture-feature.test.mjs`, 6 passed, 0 failed.
- Exactly the three expected source modules changed; no fixture test/input was altered.
- No unresolved acceptance blockers. The factual history includes one rejected submission and 16 failed tool calls; these recovered observations were not suppressed or equated with failed feature implementation.

## Evidence and boundaries

The complete stdout report is in the session tool log:

`/tmp/pi-background-terminals/session-3FiLvO/bt-13.stdout.log`

SHA-256: `87b03825c945ef8140aba51f2c19fad1553f974c1351d9294720d7d0f0c4ea84`.

The smoke script removed `/tmp/pipi-pipeline-evidence-ENwQuV` after success, including its temporary native artifacts. That removal was verified. The path printed as `reportPath` in stdout is therefore historical, not a currently readable file. This durable summary and the tool log are the retained evidence; no claim is made that the deleted fixture's manifest can still be opened.

The smoke reported unchanged host HEAD/status and installed SDK manifests. Read-only credential storage prohibited auth refresh writes. The installed launcher still reports `0.85.1`. No Jobber operation, global runtime rollout, deployment, push, or PR was performed by the smoke.

## Regression and review

- Final source checks: TypeScript, formatting, submodule pins and diff checks passed.
- Full deterministic suite: 64 installer + 550 extension + 22 file-search tests = **636 passed**.
- Independent closure: REV-001 (root-turn sealing order) and REV-002 (missing reviewed identity) fixed; 66 focused tests passed.
- A deterministic smoke first exposed a shared sandbox-parent `ENOTEMPTY` followed by verified removal of the same identity. The reducer now recognizes that narrowly proved recovery without changing raw history or weakening unrelated failures; regressions cover non-recovery and identity mismatch.

This verifies the implemented source and one live disposable feature run. Global rollout remains a separate pending operation. Crash recovery/resumption and provider-side computation proofs remain outside scope.
