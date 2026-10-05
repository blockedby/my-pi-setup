# Goal mode: pinned integration and compatibility evidence

## Conclusion and next step

Unchanged `@narumitw/pi-goal@0.54.8` **does automatically continue on real Pi 1.0.3**. The worktree-only integration passed main-agent acceptance and independent focused closure. Live installation and reload require separate approval; no primary-checkout, installed-runtime, authentication, or Git-delivery changes were made.

This addresses autonomous task continuation, not automatic quota/account management. Defaults remain 25 automatic model responses, 3 repeated tool-free automatic runs, and managed RPC disabled. Unlimited is explicitly opt-in. For the user-requested supervised long-plan mode, both `automaticTurns: null` and `noProgressTurns: null` are tested; this disables those two interruption guards without changing installation defaults.

## Reviewed identity

- Worktree: `/home/kcnc/code/tools/pipi-alias/.worktrees/goal-mode`, branch `feat/goal-mode`.
- Base/unchanged Git HEAD: `14ab1a282a2ccbb13eefa05aa6d0857be35fb89c`.
- Implementation-session product/test snapshot SHA-256: `b561d37677e499937a1f488683b2fc67a318ddcef1f135f40a64767d4fef575f` (not a Git commit).
- Parent-acceptance product/test snapshot SHA-256: `b2f4fe81bfd85acdd5e75b6b43677b78cbb6c367d468ea10bb0c7d4d40669035` (sorted changed/new non-Markdown paths, each followed by NUL, bytes, NUL; includes the supervised long-plan tests and force-include remediation, not a Git commit).
- npm revision: `76f42aeaec16aabc98af2b50ae5261e62e1c7935`.
- npm tarball integrity: `sha512-ba165WkOdBEQNYgjTa2MHgRtOh/hTLveObPzdoE29FOrfktymcBlayEHoXd9Jjw44VQ8bX7cq6V57zp0rJLVgQ==`.

The registry metadata and actual tarball were downloaded and the tarball SHA-512 checked, rather than relying on the README. Review covered the shipped entry/chunk imports and upstream lifecycle, continuation ownership/dispatch, completion tools, settings, persistence, no-progress guard, tool-policy and workflow-mutex implementations. Published README, settings and goal-management documentation were fetched separately. No upstream source was edited, rebuilt or forked. `config/pi-goal-integrity.json` records immutable manifest and generated entry/chunk hashes.

Runtime dependencies resolve to `@narumitw/pi-tui-kit@0.59.0`, `grok-mermaid@0.2.3`, and the kit's `highlight.js@11.12.0`. Both frozen Bun locks retain these and the reviewed tarball integrity. Pi peers remain 1.0.3; root TypeBox remains 1.3.27. The kit's version is fixed by a repository override within Goal's published dependency range; this does not modify Goal.

## Why notification-only `agent_settled` works here

Upstream requests continuation in `agent_end`, then dispatches a follow-up user message from `agent_settled` after checking goal ownership, active status, pending messages and idle state.

Pi 1.0.3's `AgentSession._emitAgentSettled()` marks the run inactive and sets `_isEmittingAgentSettled`. Its real `prompt()` implementation puts prompts submitted during that notification into `_deferredSettledActions`. After notification dispatch, Pi drains those actions and starts genuine new runs. `sendUserMessage()` reaches that prompt path. Goal does not make an actionable lifecycle return value; it schedules a separate run through the session API.

The SDK probes exercise this implementation, not manually invoked lifecycle handlers. They register a deterministic provider, use real `session.prompt()`, observe genuine agent/tool events, and write artifacts through an executed model-called tool. No runtime patch or Pi-version change was needed. This compatibility must be revalidated for future Pi versions; the earlier-runtime documentation alone is not a guarantee.

## Acceptance verification

Every scenario starts with one ordinary baseline prompt and verifies zero unsolicited continuation without an active goal. Every scenario also sends a managed-run bus request and verifies `RPC_DISABLED` without starting a run. Goal IDs come from persisted `goal-state` entries, never prompt-text parsing. Assertions cover schemas, tool outcomes, state and executed files, not prompt wording. Every active-goal provider request also requires an observed structured context contract with version 2, active state and the matching persisted goal ID, including after resume/compaction.

| Requirement | Real-SDK scenario / observed outcome | Result |
| --- | --- | --- |
| One start, automatic multi-run work | `completion`: 4 real runs, 9 model requests, 3 executed file-writing stages; only baseline plus one human `/goal` start | Passed |
| Matching completion ID and evidence | Stale ID leaves goal active; empty summary is rejected by the SDK schema; accepted matching-ID completion terminates and its artifact ID matches persisted state | Passed |
| Pause/clear stop stale work | `pause`, `clear`, `stale-pause`, `stale-clear`: stop during a delayed response or at the continuation-intent boundary; no later automatic request | Passed |
| Default response cap | `cap`: 25 automatic responses then `paused` / `continuation_limit`, 27 total requests including baseline and kickoff | Passed |
| Cap counts tool-loop responses | `tool-cap`: one automatic run executes 25 artifact-writing stages and pauses at response 25; 3 runs / 27 requests total | Passed |
| Explicit unlimited beyond 25 | `unlimited`: 30 automatic responses recorded, 33 runs / 34 requests, then matching completion; only baseline plus one human start | Passed |
| No-progress heuristic | `no-progress`: pauses with 3 repeated automatic tool-free outputs and `no_progress`; 5 total requests | Passed |
| Both interruption guards disabled | `unlimited-repeat`: both settings are `null`; 30 identical tool-free automatic responses then explicit completion, without human continuation | Passed |
| Supervised long-plan mode | `long-plan`: both settings are `null`; 1,125 automatically driven model responses execute 1,125 file-writing stages in one uninterrupted automatic tool loop; baseline plus one human start, then matching completion | Passed |
| State through compaction/reload/reopen/resume | `persistence`: objective, ID and waiting state survive real reload, real SDK compaction with a deterministic custom compactor, and reopening the JSONL session; resume finishes 3 artifact stages | Passed |
| New-session isolation | New session in the same workspace has no goal or unsolicited request | Passed |
| Safety state after reload | Stopped status, objective, ID, counters and safety-pause cause remain unchanged | Passed |
| Manual multi-pass coexistence | `coexist`: unchanged multi-pass 1.5.1 switches Codex provider both directions while Goal waits, without a request or goal loss; return to fake provider and resume to completion | Passed |
| Production Pipi extension coexistence | `production`: Pipi root extensions, pinned Codex adapter, multi-pass and Goal load without warnings and finish 3 artifact stages across 4 runs / 7 requests, with one human start | Passed |
| Secondary error/budget behavior | `quota` → `usage_limited`; `budget` → `budget_limited`; neither starts another request | Passed |

All 16 scenarios passed with zero network requests and unchanged synthetic auth. Ordinary children have a 15-second deadline and at most 60 provider requests; parent tests add a 25-second process bound. The long-plan stress case has a 35-second child deadline, at most 1,130 requests, and a 45-second test/process bound. Its first suite attempt hit Bun's implicit five-second per-test timeout despite a successful child result; explicit per-test timeouts now match the bounded subprocess checks. Disposable HOME, agent, workspace and session directories are removed. The fake provider proves controller behavior, **not model reasoning, prompt efficacy, real task quality, billing accuracy or provider failover**.

## Installer and installed-state contract

The root development dependency and isolated runtime dependency are exact pins. Installer preparation uses the existing frozen, transactional runtime stage. Before activation, Goal validation checks:

- name/version and exactly the advertised `dist/index.ts` entry;
- immutable manifest and all generated/lazy TypeScript chunk bytes;
- regular required files and containment inside the isolated prefix, including parent-directory symlinks;
- resolved runtime dependencies and their expected versions/entrypoints;
- actual Goal-resolved Pi peers at 1.0.3, not unrelated top-level peers.

Installed-state validation repeats these checks and requires canonical single-source loading for both Goal and multi-pass. Normalization removes equivalent npm/local/package/entry-file identities and replaces Goal-specific filters with one unfiltered local runtime source. It preserves unrelated package/settings filters. Whole upstream monorepos are preserved with Goal excluded, not deleted; an explicit empty extension allowlist stays empty. Goal-specific `+exact-path` force-includes receive matching `-exact-path` controls after retained filters, so Pi’s force-include precedence cannot revive a duplicate Goal; unrelated force-includes remain unchanged. Installer tests cover reinstall, user-limit/auth preservation, corrupt manifest/entry/lazy chunk, missing dependencies, installed corruption/duplicates and rollback of managed state plus launcher.

Installation creates no `pi-goal.json`, enables no pools or managed RPC, and does not globally choose Unlimited. Source setup and installed-state validation are tested with synthetic credentials and disposable HOME only.

## Executed validation and artifacts

- `bun run test:deterministic`: passed, 119 installer/script tests, 831 extension tests, 22 file-search tests. After adding the tool-loop cap and production-coexistence cases and stronger safety assertions, fresh `bun run test:installer` passed **121** tests. Together with browser tests this was **982 distinct tests** in the implementation-session scope. Parent acceptance then ran the complete deterministic suite with **123** script/SDK tests, **831** extension tests and **22** file-search tests, followed by **8** browser-unit tests: **984 distinct tests passed** on the strengthened scope.
- Implementation-session strengthened context-contract assertions: `bun test tests/scripts/goal.test.mjs`, 18 passed, including the original 14 real-SDK scenarios. Log: `/tmp/pipi-goal-final-goal.log`.
- `bun run test:browser`: 8 passed (control/config unit tests; no authenticated Chrome profile).
- `bun run check:bun-install`: passed; root/workspace packages, patched compiler preparation, lifecycle trust, isolated pins and native dependencies validated.
- `bun run check`, `bun run lint`, `bun run format:check`, `bun run check:submodules`, and `git diff --check`: passed.
- `bun tests/scripts/fixtures/goal-sdk-probe.mjs <goal-package> <scenario>`: all 14 cases independently repeated; JSON evidence at `/tmp/pipi-goal-sdk-results.json`.
- Parent acceptance additionally exercised `unlimited-repeat` and `long-plan` against the real SDK: 30 repeated automatic responses with the repetition guard disabled, and 1,125 executed work stages with no extra human continuation; both direct probes passed with zero network and unchanged synthetic auth. The final parent regression log is `/tmp/pipi-goal-parent-deterministic.log`; the long-plan suite case passed with explicit per-test bounds. Fresh parent Bun-install validation, typecheck, lint, formatting, pinned-submodule and diff checks also passed. Protected-state comparison confirmed the primary local record, live Pipi configuration, launcher/runtime manifests and real auth metadata were unchanged; credential contents were never inspected.
- Actual isolated SDK probe: `bun tests/scripts/fixtures/goal-sdk-probe.mjs config/pipi-runtime/node_modules/@narumitw/pi-goal completion config/pipi-runtime/node_modules/@earendil-works/pi-coding-agent`; passed with 3 executed artifact stages and zero network. Evidence: `/tmp/pipi-goal-isolated-sdk.json`.
- Production coexistence evidence: `/tmp/pipi-goal-production-sdk.json`. SDK disposal does not dispatch final async extension shutdown; the first all-production probe completed Goal successfully but the child remained alive on pre-existing Pipi UI pollers and logged stale-context defects before the 25-second process timeout. The production fixture now ends its disposable process only after successful assertions and cleanup. This bounds the test; it does not fix or certify production SDK teardown.
- Independent-review remediation reran the full affected installer/script suite: **124 passed**, including all 16 Goal SDK scenarios and the real package-manager force-include regression. Typecheck, lint, formatting, pinned-submodule and diff checks also passed; log `/tmp/pipi-goal-closure-installer.log`. The earlier complete 984-test run plus this new regression covers **985 distinct tests**, with the affected scope freshly rerun after remediation.
- Full logs: `/tmp/pipi-goal-final-deterministic.log`, `/tmp/pipi-goal-final-installer.log`, `/tmp/pipi-goal-browser.log`.
- Downloaded reviewed package/metadata: `/tmp/pipi-goal-investigation/` (temporary evidence, not an installed feature).

The initial SDK-loader probe used an explicit empty tool allowlist and correctly refused Goal activation; normal default tools were then used. Early subprocess tests also exposed upstream completion-status timers lingering after SDK disposal. Fixture cleanup now performs a genuine reload/shutdown boundary before disposal, including before replacing a completed session. The full-production scenario additionally terminates its owned subprocess after cleanup, as described above. These were harness corrections, not upstream/runtime patches; final checks passed.

## Scoped initial/closure review

Self-review followed the canonical shared code-review contract; no reviewer agent or pipeline was launched. Requirements were unchanged upstream bytes, genuine SDK continuation, preserved defaults and unrelated settings, isolated package activation, rollback and disposable-only execution. Initial reviewed identity was this branch's uncommitted integration over the stated base; closure identity is the product snapshot above.

- **REV-001, initial blocker:** converting an upstream monorepo's `extensions: []` into an exclusion-only list could activate unrelated extensions. Static filter-contract evidence showed an introduced scope violation. Closure condition: preserve disable-all and retain other filters while excluding only Goal.
- **Closure:** fixed. `normalizeGoalPackage()` preserves the empty list unchanged; `Goal source normalization preserves unrelated packages and monorepo resources` passes in the fresh installer suite. Integrity review also tightened isolated containment to reject externally linked package graphs and chunk directories, with executed regressions. No confirmed residual integration blocker remains. The pre-existing whole-production SDK-disposal/poller behavior is a concrete follow-up, not a claimed fix; its original timeout evidence and bounded-fixture disposition are recorded above.

This was scoped implementation self-review, not a security certification of the upstream package.

Independent initial review subsequently found its own **REV-001**: an upstream monorepo’s `+packages/pi-goal/<entry>` could override the glob exclusion and load a second Goal. A real `DefaultPackageManager.resolve()` reproducer failed before the fix. Remediation adds matching exact force-exclusions and publishes Goal-only controls last. The retained regression covers relative, `./`-relative and absolute force-includes, plus an already-present glob exclusion, and checks canonical-only loading, preservation of Plan resources/filters, idempotence and zero network. All four cases passed after the fix. A backslash-only spelling was removed from the Linux fixture because the actual Pi POSIX exact-path matcher does not support it; this corrected a test assumption rather than product behavior. Independent focused closure returned **READY** for the refreshed `b2f4fe81…` product identity, marked its REV-001 fixed, and reported no residual in-scope findings. Its write-free checks also exercised eight normal/ordered-delta cases, empty allowlists, idempotence, preservation of Plan, and rejection of uncorrected installed settings. Main acceptance verified unchanged executable hashes, fresh affected regressions and check/lint/format/submodule gates, one appended operation-record line, and protected live/primary state. Original blocker evidence and the scoped remediation diff are retained at `/tmp/pipi-goal-mode-remediation.diff`.

## Limits and pending work

- No live installation, main edits, real auth reads, paid model calls, commits, pushes, PRs, merges, recursive orchestration or user-owned symlink-target edits occurred.
- Whole-production SDK teardown needs separate characterization: `dispose()` alone left background UI pollers alive with stale contexts in the initial production probe; forced disposable-process exit is not a cleanup guarantee for embedded hosts.
- Actual terminal menus/settings rendering and real-provider reasoning/retry/billing were not exercised. Browser validation is unit/control coverage, not live browser/profile smoke.
- Default finite limits can still require a deliberate review/resume for long goals. `automaticTurns: null` removes only the response-count guard; separately setting `noProgressTurns: null` disables the repetition heuristic. The tested supervised long-plan profile disables both. It can consume unbounded provider usage, and the no-progress heuristic is not a semantic progress detector.
- Restoring an active goal retains its state but does not itself guarantee new work; explicit resume or normal input may be needed. Clear does not abort unrelated in-flight work.
- Manual provider switching was characterized while waiting; automatic multi-pass failover remains unsupported/unclaimed. Workflow mutex guarantees for other upstream participants on older characterized runtimes do not automatically extend to Pi 1.0.3 or Pipi pipelines.
- Main agent owns integration and final acceptance. Leave this worktree and uncommitted changes available. After separately approved delivery/rollout, install into the managed profile, validate installed state, then reload/restart existing sessions; do not treat this worktree evidence as a live rollout.
