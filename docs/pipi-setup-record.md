# Pipi setup record

This is the durable, user-facing record for the local `pipi` setup. Append future Pipi requests here after they are implemented or clearly identified as pending. Never record tokens, API keys, OAuth credentials, cookies, or auth-file contents.

## Current installation

| Item                                    | Location / value                                         |
| --------------------------------------- | -------------------------------------------------------- |
| Source checkout                         | `/home/kcnc/code/tools/pipi-alias`                       |
| Source branch                           | `main`                                                   |
| Launcher                                | `/home/kcnc/.local/bin/pipi`                             |
| Pipi Pi executable                     | `/home/kcnc/.pipi/agent/npm/node_modules/.bin/pi`        |
| Pipi runtime package                   | `@earendil-works/pi-coding-agent@0.84.2`                 |
| Pipi settings                           | `/home/kcnc/.pipi/agent/settings.json`                   |
| Pipi model overrides                    | `/home/kcnc/.pipi/agent/models.json`                     |
| Tracked model-override record           | `config/pipi-model-overrides.json`                       |
| Pipi sessions                           | `/home/kcnc/.pipi/sessions`                              |
| Creator setup package                   | `/home/kcnc/code/tools/pipi-alias`                       |
| Codex tools package                     | `/home/kcnc/code/tools/pi-codex`                         |
| MCP adapter                             | `npm:pi-mcp-adapter@2.15.0`                              |
| Isolated MCP package files              | `/home/kcnc/.pipi/agent/npm/node_modules/pi-mcp-adapter` |
| Browser Chrome skill                    | `/home/kcnc/.pipi/agent/skills/browser-chrome`           |
| Evidence-driven reviewer submodule      | `vendor/gpt5.6-reviewer` at `81053d6`                    |
| Canonical code-review skill             | `vendor/gpt5.6-reviewer/skills/code-review`              |
| Backlog planning submodule              | `vendor/plan-gh-backlog` at `2913620`                    |
| Canonical plan-gh-backlog skill         | `vendor/plan-gh-backlog`                                 |
| Browser MCP config                      | `/home/kcnc/.pipi/agent/mcp.json`                        |
| Theme                                   | `github-dark-default`                                    |
| Current Pipi Pi version                 | `0.84.2`                                                 |
| Original Pipi Pi version                | `0.82.1`                                                 |
| Codex CLI version at initial acceptance | `0.145.0`                                                |

## Isolation contract

- `pipi` launches the exact pinned runtime at `/home/kcnc/.pipi/agent/npm/node_modules/.bin/pi` (`@earendil-works/pi-coding-agent@0.84.2`); it is not a second global installation and does not replace or launch regular `pi` by default.
- The launcher exports `PI_CODING_AGENT_DIR=/home/kcnc/.pipi/agent`.
- The launcher exports `PI_CODING_AGENT_SESSION_DIR=/home/kcnc/.pipi/sessions`.
- Regular Pi settings, sessions, auth, and MCP override files remain under `/home/kcnc/.pi/agent`.
- Pipi auth is separate by default. No auth secret bytes were copied.
- Pipi's MCP adapter is isolated under `~/.pipi/agent/npm`.
- The browser skill and MCP commands are Pipi-owned copies under `~/.pipi/agent`.
- The canonical code-review and plan-gh-backlog skills are loaded directly from initialized, commit-pinned submodules; no duplicate host copies are loaded.
- The installer never fetches or advances either submodule, and no optional Python CLI is globally installed by Pipi setup.
- The optional `pi-subagents` named-agent extension is not installed.
- Regular Pi's `mcp.json` was not copied or linked because it contains environment fields that may hold secrets.
- The removed web-search provider is not installed, configured, or required.

## Completed work

### 1. Creator setup checkout

- Cloned `https://github.com/davis7dotsh/my-pi-setup` into `/home/kcnc/code/tools/pipi-alias`.
- Created local branch `feat/pipi-alias`.
- Preserved the creator's subagents, workflows, background terminals, file search, summaries, Git/model status UI, ask-user, copy-all, skills, and GitHub Dark Default theme.

### 2. Removed web-search provider

- Removed the provider's extension directory.
- Removed its npm dependency and lockfile entries.
- Removed `.env.example` and its API-key setup instructions.
- Added an automated tracked-source test that rejects the removed provider's path or content reference.

### 3. Isolated installer and launcher

- Added `scripts/install.mjs` and `scripts/uninstall.mjs`.
- Added `~/.local/bin/pipi` with managed-file protection.
- Added isolated settings and session directories under `~/.pipi`.
- Added safe, atomic JSON settings writes and restrictive config permissions.
- Preserved unrelated existing Pipi settings and package entries.
- Seeded missing provider/model/thinking defaults from regular Pi without writing regular Pi settings.
- Added an explicit `--share-auth` option that creates a symlink only; default auth remains independent.
- Added a dependency installer for the root and dependency-bearing extension packages.

### 4. Installer verification

- Added temporary-HOME integration tests with fake `pi` and `codex` executables.
- Covered clean install, idempotence, environment routing, argument quoting, existing settings, missing Pi, unmanaged launcher protection, explicit auth sharing, uninstall/purge, and removed-provider exclusion.
- Fixed npm-script PATH shadowing so the launcher uses `/home/kcnc/.local/bin/pi`, not the repository's `node_modules/.bin/pi` shim.
- Initial source commits:
  - `a094812` — `feat: add isolated pipi installer`
  - `9abd5bd` — `fix: prefer installed pi over npm shim`

### 5. Codex integration

- Reused the existing Codex CLI instead of installing another CLI.
- Registered `/home/kcnc/code/tools/pi-codex` as a local Pipi package.
- Installed its dependencies with `npm ci`.
- Verified that Pipi package discovery lists both the creator setup and `pi-codex-tools`.
- Kept deterministic Codex-backed search, fetch, patch, and bounded task tools as the replacement for the removed provider.

### 6. Initial real installation and acceptance

- Installed `pipi` for the current user.
- Verified `pipi --version` and `pi --version` both reported `0.82.1` at initial acceptance.
- Verified the regular Pi executable and settings did not change during install/runtime probes.
- Ran targeted installer, type, format, package, permissions, startup, and exclusion checks.
- Received an independent AAD audit verdict: `PASS with limitations (accepted)`.
- Did not push, publish, or open a pull request.

### 7. Agent-prompt and graph documentation

- Located model-facing prompt definitions under `extensions/*/prompt.ts`.
- Confirmed subagent task prompts are created dynamically and sent directly to Pi, Claude, or Codex backends.
- Confirmed children are leaf workers: child sessions exclude subagent management, workflow, and ask-user tools; Claude also disables native Agent/Task tools.
- Added a responsive black-and-white B2-English guide:
  - `docs/subagents-explained.html`
  - Includes the meaning of “removes,” the parent/leaf graph, tool filtering, task flow, capability table, and source links.
  - Browser-checked at desktop and 390px mobile widths with no console error or horizontal overflow.

### 8. MCP adapter integration

- Reused the MCP adapter extension already reviewed and installed by regular Pi.
- Pinned Pipi to the same observed adapter version: `npm:pi-mcp-adapter@2.15.0`.
- Added installer migration from unversioned or older `npm:pi-mcp-adapter` entries to one pinned entry while preserving package filters.
- Added isolated npm installation under `~/.pipi/agent/npm` so an older globally installed adapter cannot shadow version 2.15.0.
- Extended installer tests to prove exact-once registration, migration/idempotence, and that regular Pi's secret-bearing MCP config is not copied.
- Installed and verified version 2.15.0 at `/home/kcnc/.pipi/agent/npm/node_modules/pi-mcp-adapter`.
- Recorded the MCP integration and documentation in the local `feat: add isolated MCP adapter` commit.

### 9. Browser Chrome skill and MCP

- Vendored the exact `browser-chrome` skill from `/tmp/opencode/pi-agent-setup-main`.
- Installed it under `~/.pipi/agent/skills/browser-chrome` with private file modes and executable owner-only shell scripts.
- Created Pipi's own `mcp.json` with exactly these managed browser entries:
  - `browser-chrome-control`
  - `browser-chrome-headed`
  - `browser-chrome-headless`
- Pointed every browser MCP command at Pipi-owned scripts; no regular Pi path, config, credential, or browser data was copied.
- Preserved unrelated Pipi MCP entries during installer reruns.
- Verified the control MCP exposes four policy tools and disposable headless MCP exposes 29 Chrome DevTools tools.
- Verified the headless smoke probe cleaned up its temporary Chrome process and did not use an authenticated profile.
- The first implementation also added `pi-subagents`, `chrome-browser-agent.md`, and its `aad-task-package` dependency. The user clarified that only the browser skill and MCP should remain, so those three named-agent resources plus the extension's orphaned isolated npm dependencies/binaries were removed from source, installer registration, and installed Pipi state.

### 10. GPT-5.6 context-window overrides

- Added Pipi-only model overrides at `/home/kcnc/.pipi/agent/models.json`.
- Initially set `openai-codex/gpt-5.6-sol` to a 500,000-token context window; section 17 records the later correction to 350,000 tokens.
- Set `openai-codex/gpt-5.6-terra` and `openai-codex/gpt-5.6-luna` to 300,000 tokens each.
- Preserved the built-in 128,000-token maximum output for all three models.
- Added the source-controlled record `config/pipi-model-overrides.json`; it mirrors the runtime file without credentials.
- Extended `AGENTS.md` so future context-window changes keep the tracked and runtime copies synchronized.
- Verified the composed values with `pipi --list-models`.

### 11. Durable operation logging and main publication

- Updated root `AGENTS.md` to require a log entry after every user-requested Pipi operation.
- Each entry must record the request, action, affected paths or values, verification, and pending steps without secrets.
- Updated `docs/gpt-context-window-report.html` to reflect the configured 500K / 300K / 300K values.
- Verified TypeScript with `npm run check`, repository formatting with `npm run format:check`, changed-file formatting with Prettier, and whitespace with `git diff --check`.
- Verified `config/pipi-model-overrides.json` exactly matches `/home/kcnc/.pipi/agent/models.json`.
- Verified the composed Sol, Terra, and Luna context windows with `pipi --list-models`.
- Published the validated configuration and documentation as commit `15ece42` from local `main` to `origin/main`; this follow-up records the successful push result.

### 12. Evidence-driven reviewer submodule and canonical skill

- Added `https://github.com/blockedby/gpt5.6-reviewer.git` as a real Git submodule at `vendor/gpt5.6-reviewer`, with the parent gitlink pinned to commit `81053d6a05f2160341582d2eacf30cbc9f2c3bd5` and `.gitmodules` tracking `main` for explicit maintainer updates.
- Replaced the older host `skills/code-review` copy with the submodule's canonical `skills/code-review` package path, preventing Pi skill-name collisions.
- Added durable initialize/update/no-direct-edit rules to `AGENTS.md` and machine-readable integration requirements in `config/submodules.json`.
- Added `scripts/check-submodules.mjs`, `npm run check:submodules`, initialized/clean gitlink coverage, installer preflight coverage, and user/setup documentation.
- Kept the Python contract CLI available in the pinned child but did not install or execute it as part of Pipi setup.
- Re-ran the isolated Pipi installer with `--skip-dependencies`; it validated and reported the canonical submodule skill while preserving the existing package list and isolated runtime paths.
- Verified 19 installer/submodule tests, 51 child reviewer tests on the default Python, TypeScript, Prettier, submodule integrity, both reviewer example results, and 8 existing browser-control tests. No live model or authenticated browser check was run.
- The earlier subtree implementation was independently reviewed and remediated before the user clarified that GitHub must display a true submodule. A fresh review of the final submodule composition found three integration/documentation blockers; all were remediated with retained tests and closure returned `READY`.
- Updated pull request #3 from `feat/evidence-driven-reviewer-subrepo`; merge remains a separate user decision.

### 13. Disposable `/tmp` installation acceptance

- Created `/tmp/pipi-submodule-install-check` with separate uninitialized and recursive clones, fake `pi`/`codex` executables, isolated HOME directories, logs, and package fixtures.
- Confirmed the uninitialized clone exits 1 with the documented `git submodule update --init --recursive` instruction and creates no Pipi state or launcher.
- Confirmed the recursive clone resolves `vendor/gpt5.6-reviewer` exactly to gitlink commit `81053d6a05f2160341582d2eacf30cbc9f2c3bd5` with a clean child worktree.
- Ran `check:submodules` and all 19 installer/submodule tests from the fresh clone.
- Verified skip-dependency installation, byte-stable idempotent reinstall, isolated launcher environment/argument forwarding, non-purge uninstall preservation, and purge removal.
- Ran the full dependency installer in the temporary clone, verified isolated `pi-mcp-adapter` 2.15.0, three expected package entries, separate auth, launcher operation, and complete purge.
- Built the child Python wheel in `/tmp`, installed it into a clean virtual environment, and validated request/result/routing behavior through the installed `evidence-review` entry point.
- No live model, authenticated browser, production location, or regular Pi setting was used. The temporary clones and logs remain available for inspection and can be deleted as one directory.

### 14. PR merge and local Pipi refresh

- Merged pull request #3 into `origin/main` as merge commit `581c344b643b039cd517d3663944e335a227b70e` and removed the remote feature branch.
- Fast-forwarded the local `main`, synchronized `.gitmodules`, and initialized the reviewer child at gitlink commit `81053d6a05f2160341582d2eacf30cbc9f2c3bd5`.
- Re-verified the exact clean gitlink, 19 installer/submodule tests, 51 child tests, TypeScript, Prettier, and both review-result examples from merged `main`.
- Re-ran `npm run install:pipi -- --skip-dependencies` against the real isolated local setup.
- Verified `pipi --version` reports `0.82.1`, the three expected package sources remain registered, the canonical package skill exists under the reviewer submodule, and no duplicate host `skills/code-review` path exists.
- Preserved separate Pipi auth and did not invoke a live model or browser.

### 15. Post-merge repository review

- Ran the pinned independent reviewer role from `vendor/gpt5.6-reviewer` over the complete reviewer-submodule integration, using base `38736f93a2b0d4bef2ad9ff2a187258f76c4c4f4` and head `a830629295002a388ef2149b06427dcef3368648`.
- The reviewer returned `READY` with no findings.
- It verified the exact gitlink, child HEAD/origin/cleanliness, required assets, manifest uniqueness, duplicate absence, installer/submodule tests, TypeScript, formatting, child reviewer tests, example validators, and browser-control unit tests.
- The review was read-only and did not merge, push, advance the child, invoke live models, or use browser automation.

### 16. General skills installed into Pipi

- After `pi-agent-setup` pull request #24 was merged, installed its `general` skill set into the isolated Pipi agent directory with the ownership-safe skill installer.
- Installed exactly nine general skills under `$HOME/.pipi/agent/skills`: `backend-quality`, `browser-chrome`, `completion-verification`, `devops-quality`, `explanatory-html-pages`, `frontend-quality`, `git-branching`, `modern-skill-revising`, and `visual-composition`.
- Replaced the pre-existing `browser-chrome` and `explanatory-html-pages` copies only after verifying they matched the merged sources; unrelated Pipi skills and settings were preserved.
- Verified the ownership manifest records all nine skills under `general`, records no AAD skills, and each installed skill contains `SKILL.md`. No live model or browser session was invoked.
- A new Pipi session or `/reload` is still needed for an already-running session to discover the installed skills.

### 17. Corrected Sol context window

- The user reported that 500,000 tokens was too high for `openai-codex/gpt-5.6-sol` in Pipi and requested the observed 350,000-token limit instead.
- Changed Sol from 500,000 to 350,000 tokens while leaving Terra and Luna at 300,000 tokens and preserving the built-in maximum-output metadata.
- Updated the tracked installation record at `config/pipi-model-overrides.json`, synchronized the live Pipi file at `/home/kcnc/.pipi/agent/models.json`, and revised `docs/gpt-context-window-report.html` to show the current 350K / 300K / 300K values.
- Verified both JSON files parse, match byte-for-byte, and compose through `pipi --list-models` as Sol 350K and Terra/Luna 300K. Verified repository TypeScript, formatting, and whitespace checks.
- Pending: reload Pipi or reselect Sol through `/model` so the already-running root session refreshes its model metadata; future sessions will read the new value automatically.

### 18. Researched Luna/Terra subagent routing

- The user asked whether Pipi can delegate more routine tool calls, repository exploration, and audit work to Luna and Terra, and requested a brief options summary before implementation.
- Read the installed Pi extension documentation, upstream subagent example, and Pipi's subagent/workflow model-selection and child-tool policy. Launched read-only Luna and Terra Codex subagents against this repository; Luna completed its audit and Terra was cancelled after its source findings were confirmed independently.
- Confirmed the existing `subagent_spawn` tool already accepts explicit `model` selection for Pi and Codex harnesses, and workflows accept per-agent `model`, `provider`, and `effort`. Pi children keep normal tools but remain leaf workers without subagent, workflow, or ask-user tools; the shared concurrency cap is four.
- Verified `pipi --list-models` exposes `openai-codex/gpt-5.6-luna` and `openai-codex/gpt-5.6-terra`, each with the configured 300K context window. No routing implementation or runtime configuration was changed; affected repository path is only this operation record.
- Pending: choose between prompt-level routing guidance, fixed read-only Luna/Terra agent presets, or a deterministic routing extension with task profiles and tool restrictions before implementation.

### 19. Began sequential review of Luna/Terra routing options

- The user requested reviewing each proposed Luna/Terra delegation option in order, beginning with prompt-level routing guidance.
- Assessed the prompt-only option against `extensions/subagents/src/prompt.ts`, `skills/subagents/SKILL.md`, and the existing Pi child model/tool behavior. No routing implementation or runtime configuration was changed; affected repository path is only this operation record.
- The proposed policy uses Luna for bounded read-only exploration that benefits from multiple tool calls, Terra for deeper audits and evidence verification, and keeps Sol responsible for edits, integration, user interaction, and final acceptance checks. It avoids delegating trivial single-file lookups because subagent startup adds latency and cost.
- Pending: the user should accept, revise, or reject prompt-level routing before the review proceeds to fixed named presets.

### 20. Confirmed current subagent concurrency limits

- The user rejected the proposed soft recommendation of two research agents and asked for the current hard cap, noting a desired capacity of up to 30 concurrent agents.
- Confirmed `extensions/subagents/src/manager.ts` currently enforces `MAX_RUNNING = 4` across Pi, Claude, and Codex subagents, while retaining up to 64 tracked entries. The same four-way concurrency limit is documented in the subagent tool prompt and skill and asserted by manager tests.
- Confirmed the workflow subsystem separately caps simultaneous workflow children at four and allows at most 32 total agent calls per workflow run.
- No concurrency implementation or runtime configuration was changed; affected repository path is only this operation record. Pending: decide whether a future 30-agent limit should apply only to direct background subagents or also to workflow fan-out, and preferably make the limit configurable rather than replacing one hard-coded value with another.

### 21. Proposed model-specific concurrency budgets

- The user specified desired simultaneous limits of four Sol agents, eight Terra agents, and sixteen Luna agents.
- Assessed the change as a model-aware quota system rather than a single replacement for `MAX_RUNNING`. The safest design canonicalizes requested/inherited model identities before reserving a slot, counts both running and in-progress spawn reservations to prevent races, and keeps explicit fallback and total limits for omitted or unrelated models.
- No concurrency implementation or runtime configuration was changed; affected repository path is only this operation record.
- Pending: decide whether the 4/8/16 quotas are shared globally across direct subagents and workflow children or maintained separately by each subsystem. A shared quota requires a common coordinator because the current subagent and workflow runtimes enforce concurrency independently.

### 22. Reviewed quota topology for automatic model-selected delegation

- The user explained that workflows are currently unused and prefers the main agent to choose delegation automatically, then asked for the technically best design based on the code topology.
- Inspected the independent direct-subagent and workflow execution paths and ran a read-only Terra Pi subagent audit. Both analyses found that direct subagents are coordinated by `SubagentManager`, while workflows create their own child sessions through a separate `RunController` and are intentionally gated behind explicit workflow or `ultracode` requests.
- Recommended implementing automatic routing and the 4 Sol / 8 Terra / 16 Luna quotas in direct Pi subagents first, preserving the manager's synchronous reservation behavior for spawn and restart races. Workflow should retain its current separate limit until it is actually adopted; a shared coordinator can be extracted later instead of coupling two currently independent systems prematurely.
- No routing, quota, workflow, or runtime configuration was changed; affected repository path is only this operation record. Pending: accept or revise this architectural direction before implementation or before continuing to the fixed-preset option.

### 23. Reviewed fixed Luna/Terra profiles

- After retaining the direct-subagent quota design, the user asked to continue to the next option: named capability profiles for routine exploration and audit work.
- Confirmed Pi's SDK supports an explicit active-tool allowlist together with the existing child-tool denylist. Assessed adding optional profiles to the current `subagent_spawn` path rather than restoring the previously removed `pi-subagents` named-agent extension.
- The proposed `luna-explore` profile fixes the Pi harness, Luna model, evidence-oriented system guidance, and a strict read-only tool allowlist. The proposed `terra-audit` profile fixes the Pi harness and Terra model; strict read-only mode would omit `bash`, while allowing `bash` would make non-mutation a prompt policy rather than a technical guarantee.
- No profile, routing, quota, or runtime configuration was changed; affected repository path is only this operation record. Pending: choose whether profiles are selected through one optional `subagent_spawn.profile` field or exposed as separate tools, then decide whether Terra audit receives `bash`.

### 24. Chose profile selection with prompt-only read-only behavior

- The user selected a `profile` field on the existing `subagent_spawn` tool instead of separate Luna/Terra tools.
- The user also chose to keep each Pi child's normal tool set and enforce read-only exploration/audit behavior through profile system guidance rather than a technical tool allowlist. This preserves the ability to delegate multi-step tool chains, shell-based inspection, and routine checks to cheaper models.
- The resulting profile design fixes harness and model selection, adds role-specific system guidance, and uses the existing child exclusions only for recursive orchestration and user interaction. Quotas remain tied to each profile's canonical model; no profile, routing, quota, or runtime configuration was changed.
- Affected repository path is only this operation record. Pending: choose profile defaults such as reasoning effort and finalize the exact Luna/Terra role prompts before implementation.

### 25. Set both profile reasoning defaults to high

- The user selected `high` reasoning effort as the default for both `luna-explore` and `terra-audit`.
- The planned profiles therefore fix Pi harness, Luna or Terra model, high effort, full normal child tools, prompt-only read-only behavior, and the existing leaf-worker exclusions. Explicit per-call effort may remain an override if retained in the final schema.
- No profile, routing, quota, or runtime configuration was changed; affected repository path is only this operation record. Pending: review the automatic host-router option, then consolidate the accepted design before implementation.

### 26. Rejected a host-side automatic router

- The user chose not to implement the third option: a host-side keyword or prompt-shape router that launches Luna/Terra before the main agent decides.
- The accepted direction keeps semantic routing with the main agent through model-facing guidance, then uses the selected `subagent_spawn.profile` to fix the Pi harness, model, high effort, and role prompt. Model-aware manager quotas provide deterministic admission without host-side task classification.
- No profile, routing, quota, or runtime configuration was changed; affected repository path is only this operation record. Pending: consolidate the accepted schema, prompts, quota behavior, tests, and installer/runtime synchronization into an implementation plan or begin implementation after explicit approval.

### 27. Chose TypeScript as the policy source of truth

- The user chose TypeScript constants instead of a separately installed JSON file for Luna/Terra profiles and the 4/8/16 model quotas.
- The planned implementation should centralize profile definitions and quota values in one typed policy module consumed by tool schema/guidance, admission logic, and tests, rather than duplicating literals across the extension.
- No profile, routing, quota, or runtime configuration was changed; affected repository path is only this operation record. Pending: approve implementation or request the concrete patch plan first.

### 28. Consolidated the Luna/Terra implementation plan

- The user requested a single summary and overall implementation plan before any product-code changes.
- Consolidated the accepted design: main-agent semantic routing; optional profiles on `subagent_spawn`; Pi/Luna and Pi/Terra profiles with high effort, full normal tools, and prompt-only read-only behavior; direct Pi model quotas of Sol 4, Terra 8, and Luna 16; a conservative aggregate limit for non-Pi backends; unchanged workflows; and no host-side keyword router.
- Planned a typed policy module, canonical pre-admission Pi model resolution, immutable quota keys with race-safe reservation/restart behavior, profile system-prompt injection, focused manager/model/profile tests, documentation updates, complete repository checks, and evidence-driven closure review.
- No profile, routing, quota, or runtime configuration was changed; affected repository path is only this operation record. Pending: review and approve the plan, then explicitly authorize implementation.

### 29. Moved work into a feature worktree and implemented profiles

- The user authorized implementation, requested moving all current changes into a worktree, and requested preparation of a final pull request.
- Created `/home/kcnc/code/tools/pipi-alias/.worktrees/luna-terra-subagent-profiles` on `feat/luna-terra-subagent-profiles` from the current `origin/main`, carried the three existing local documentation commits and all uncommitted Pipi changes into it, verified the transferred patch byte-for-byte, and reset the primary `main` checkout to a clean `origin/main` state.
- Added the typed policy source of truth under `extensions/subagents/src/policy.ts`, optional `luna-explore` and `terra-audit` profiles, profile conflict validation, main-agent routing guidance, profile system-prompt injection, canonical Pi model resolution, and direct quotas of Sol=4, Terra=8, and Luna=16. Claude and Codex retain one aggregate direct-session cap of 4; workflows remain unchanged.
- Profile children retain their normal tools except the existing recursive-orchestration and ask-user exclusions. Read-only behavior is system guidance rather than a technical tool restriction, preserving multi-step tool chains for Luna and Terra.
- Removed a temporary worktree `node_modules` symlink after confirming the existing `node_modules/` ignore rule treats a symlink as a file rather than a directory; dependencies were then installed normally inside the ignored worktree paths.
- Local verification passed TypeScript, formatting, submodule validation, all 19 installer tests, all 22 file-search tests, and 129 deterministic non-live extension tests, including mixed 4/8/16 admission, inherited model quotas, failed-spawn reservation release, non-Pi aggregation, and immutable restart admission. Paid/live Claude and Codex backend tests were intentionally excluded.
- The required independent initial review used the canonical vendored reviewer policy against base `e525aeb`; verdict `READY` with no findings.
- Committed and pushed the feature, then opened [PR #5](https://github.com/blockedby/my-pi-setup/pull/5) against `main`. The required target-branch preparation rebased onto `origin/main` and exposed one conflict in `extensions/subagents/src/prompt.ts`; resolution preserves both upstream nonblocking automatic result delivery and the new Luna/Terra routing guidance.
- Post-rebase verification reran the full non-live matrix successfully: TypeScript, formatting, submodule validation, 129 extension tests, 19 installer tests, 22 file-search tests, and tracked/live model override comparison. The rebased branch was force-pushed with lease. GitHub currently reports no configured checks for this branch; pending steps are PR review/merge and reloading Pipi after merge.

## Current package sources

The installer keeps these package sources in Pipi settings:

```text
/home/kcnc/code/tools/pipi-alias
npm:pi-mcp-adapter@2.15.0
/home/kcnc/code/tools/pi-codex
```

Unrelated user-added Pipi packages are preserved. The reviewer is a pinned Git submodule used by the creator setup package, not a separate Pipi settings package.

## How to use MCP in Pipi

Start Pipi and open the adapter panel:

```text
/mcp
```

Useful commands:

```text
/mcp setup
/mcp tools
/mcp reconnect
/mcp reconnect <server>
/mcp-auth <server>
```

Pipi now has its own three browser Chrome MCP servers. Use `browser-chrome-control` first, then follow its guidance to use `browser-chrome-headless` or `browser-chrome-headed`. Pipi still does not automatically inherit regular Pi's private `~/.pi/agent/mcp.json`. Use `/mcp setup` only to add other isolated servers. Standard shared MCP files such as `~/.config/mcp/mcp.json` or a project `.mcp.json` remain discoverable by the adapter.

## Request log

1. Create isolated `pipi` beside regular Pi from the creator setup, reuse Codex, and exclude the removed web-search provider — completed.
2. Check and install `/home/kcnc/code/tools/pi-codex` dependencies — completed.
3. Explain where agent prompts are configured and provide the upstream subagents link — completed in chat and this record.
4. Explain the leaf-subagent graph and “removes” in B2 English as a black-and-white HTML page — completed in `docs/subagents-explained.html`.
5. Add the MCP adapter from regular Pi and record completed/future work — completed with isolated adapter 2.15.0 and this file.
6. Add the browser Chrome resources from `pi-agent-setup` and log the work — completed and recorded in section 9.
7. Add short README tables explaining the installed agents and skills — completed in `README.md`.
8. Remove the unrequested `pi-subagents` extension and keep only the browser skill plus MCP — completed; the named-agent file and its agent-only skill dependency were also removed and this correction was logged.
9. Configure and durably record custom GPT-5.6 context windows — completed with Sol at 500K and Terra/Luna at 300K in both the Pipi runtime config and `config/pipi-model-overrides.json`.
10. Require every user-requested Pipi operation to be logged and push this work to `main` — logging policy added to `AGENTS.md`; repository validation and push evidence are recorded below.
11. Add the evidence-driven reviewer as a subrepo, make its skill integration canonical, check related scripts, add maintenance rules, and prepare a pull request; after clarification, convert it to a true Git submodule visible on GitHub — implemented on `feat/evidence-driven-reviewer-subrepo`; merge remains pending user review.
12. Create a disposable installation under `/tmp` and check the install/uninstall scripts — completed at `/tmp/pipi-submodule-install-check` with uninitialized, recursive, skip-dependency, full-dependency, idempotence, launcher, uninstall, purge, and child Python-package checks.
13. Merge pull request #3 and update the real local Pipi setup — merged as `581c344`, synchronized local `main` and the pinned submodule, re-ran checks, refreshed Pipi with `--skip-dependencies`, and verified version/package/skill isolation.
14. Run the review agent over the updated repository — completed read-only against base `38736f9` and head `a830629`; verdict `READY`, no findings.
15. Merge `pi-agent-setup` pull request #24, then install only its general skills into Pipi — completed with nine general skills, exact ownership tracking, no AAD skills, and no changes to regular Pi.
16. Replace Sol's too-high 500K context override with the user-reported real 350K limit in both the tracked installation setup and live Pipi configuration — completed; Terra and Luna remain at 300K.

## Pending steps explicitly connected to user requests

1. **Authenticate Pipi for model use.** Run `pipi`, then `/login`, unless auth sharing is explicitly requested. The default remains separate.
2. **Reload after this installation.** Start a new Pipi session or run `/reload` so the nine general skills, browser MCP configuration, and canonical evidence-driven code-review skill are refreshed.
3. **Choose browser mode safely.** Use disposable headless mode by default. Use headed persistent mode only when a future requested task needs the current browser login/profile.
4. **Choose any additional MCP servers.** Browser MCP is configured. Use `/mcp setup` only for other servers; importing regular Pi's secret-bearing config requires a separate explicit decision.
5. **Keep this record current.** `AGENTS.md` now requires every user-requested Pipi operation to append the request, action, affected paths or values, verification, and pending steps here without secrets.
6. **Remove disposable acceptance files when no longer needed.** `/tmp/pipi-submodule-install-check` contains only temporary clones, fake executables, isolated homes, logs, a wheel, and a virtual environment created for this test.
7. **Refresh the active Sol metadata.** Run `/reload` or reselect `openai-codex/gpt-5.6-sol` through `/model`; new Pipi sessions automatically read the 350K override.

## Discussed ideas that are not requested implementation

These were discussed or explained, but they are not active work:

- Add named editable agent-prompt presets such as planner, implementer, and reviewer.
- Allow subagents to create nested subagents. The current leaf-worker design intentionally blocks this and would need depth, cost, permission, and cancellation limits before changing.

## Verification commands

Use targeted checks that do not call paid models:

```sh
cd /home/kcnc/code/tools/pipi-alias
npm run check:submodules
npm run test:installer
npm run check
npm run format:check
node --test vendor/pi-agent-setup/skills/browser-chrome/control-mcp/*.test.mjs
pipi --version
pipi list
```

Avoid broad live backend tests unless explicitly authorized. The upstream broad test command can detect installed Claude/Codex CLIs and invoke live backend tests.

## Change-control rules

- Do not restore the removed web-search provider.
- Do not copy or print secrets.
- Do not modify regular Pi settings as part of Pipi installation.
- Do not push or publish without explicit permission.
- Prefer pinned, isolated dependencies when global package resolution could select the wrong version.
- Do not edit `vendor/gpt5.6-reviewer` directly; initialize it with `git submodule update --init --recursive`, and update it only by reviewing a child commit and committing the changed parent gitlink.
- Keep `.gitmodules` and `config/submodules.json` synchronized; installers must never fetch or advance the child automatically.
- Do not restore a duplicate host `skills/code-review`; load the canonical submodule skill through `package.json`.
- Record future completed and pending work in this file.

## Operation entry: nonblocking parent turns for subagents

- **Request:** Remove guidance telling the main agent to wait when a subagent result is required, strengthen automatic follow-up-turn guidance, and prepare the first-stage change as a pull request.
- **Action:** Updated model-facing spawn descriptions, guidelines, and result text so the parent ends its current turn when no independent work remains, leaves the overall task pending, and relies on automatic result delivery to trigger a follow-up parent turn. Removed the blocking-wait recommendation from the subagents skill. A focused prompt-contract test was initially added, then removed at the user's explicit request. Runtime delivery behavior and shell/tool enforcement were intentionally unchanged in this first stage.
- **Affected paths:** `extensions/subagents/src/prompt.ts`, `skills/subagents/SKILL.md`, and this record.
- **Verification:** `npm run check`, `npm run format:check`, and `git diff --check` passed after installing worktree dependencies. The initial type-check attempt failed because the new worktree lacked extension dependencies; rerunning after `npm run install:dependencies` passed.
- **Pending:** Review and merge the pull request; then reload or restart Pipi before manually confirming that a main session becomes idle instead of issuing `sleep` while subagents run.

## Operation entry: merged nonblocking guidance and refreshed Pipi

- **Request:** Merge pull request #4 and then update the local Pipi setup.
- **Action:** Squash-merged pull request #4 into `main` as `696a97d46acec92dbe4edf584d9a8f724a62d48d`, fast-forwarded the local target checkout, removed the feature worktree and local feature branch, and reran `npm run install:pipi -- --skip-dependencies` against the isolated local setup.
- **Affected paths or values:** Local and `origin/main` now point to the merged guidance; the Pipi launcher remains `/home/kcnc/.local/bin/pipi`, settings remain `/home/kcnc/.pipi/agent/settings.json`, and package discovery still uses `/home/kcnc/code/tools/pipi-alias`, `/home/kcnc/code/tools/pi-codex`, and `npm:pi-mcp-adapter@2.15.0`.
- **Verification:** Pull request #4 reports `MERGED`; local `main` is synchronized with `origin/main`; `pipi --version` reports `0.82.1`; `pipi list` reports all three expected package sources; source inspection confirms the automatic follow-up-turn and no-wait guidance; feature worktree and local feature branch removal were verified.
- **Pending:** Reload this already-running Pipi session or start a new one before manually testing the updated model-facing guidance.

## Operation entry: Luna/Terra profile live acceptance smoke tests

- **Request:** After merging PR #5, test both new direct-subagent profiles against read-only repository inspection tasks.
- **Action:** Started bounded non-interactive Pipi runs that called `subagent_spawn` once with `luna-explore` and once with `terra-audit`, without explicit harness, model, or reasoning-effort overrides. Temporary JSON event logs were inspected and then deleted.
- **Affected paths or values:** `README.md` and `package.json` were inspection-only; this durable record is the only repository path changed by the smoke-test parent. The tested profiles were `luna-explore` and `terra-audit`.
- **Verification:** Both JSON-mode runs exited 0. Their tool calls contained only the requested profile/name/prompt fields, and spawn results resolved to Pi with `openai-codex/gpt-5.6-luna` and `openai-codex/gpt-5.6-terra` respectively. Non-interactive print mode exits after the parent turn and therefore did not retain the background child long enough for automatic final-result delivery; deterministic tests cover child execution and delivery behavior.
- **Pending:** After reloading an interactive Pipi session, optionally confirm end-to-end automatic final-result delivery for each profile in the TUI.

## Operation entry: merged and verified Luna/Terra profiles

- **Request:** Merge PR #5 and test the resulting Pipi setup.
- **Action:** Squash-merged PR #5 as `7c951109f9aebac21321621d7174793871c4e4ae`, synchronized local `main`, removed the merged feature worktree and local branch, reinitialized the canonical reviewer submodule after worktree cleanup, and refreshed the isolated Pipi installation with `--skip-dependencies`.
- **Affected paths or values:** `main` and `origin/main` point to the merged profile implementation; the remote feature branch is intentionally retained. Installed Pipi still uses `/home/kcnc/code/tools/pipi-alias`, and model metadata reports Sol 350K plus Terra/Luna 300K.
- **Verification:** Post-merge TypeScript, formatting, submodule validation, 129 deterministic non-live extension tests, 19 installer tests, and 22 file-search tests passed. `pipi --version` reports 0.82.1, `pipi list` reports the three expected package sources, both live profile spawn checks resolved the expected models, and the primary checkout is synchronized with `origin/main`.
- **Pending:** Reload this already-running Pipi session or start a new interactive session before TUI-level automatic result-delivery testing.

## Operation entry: Pi 0.83 upgrade

- **Request:** Upgrade this Pipi setup from the `@earendil-works` Pi 0.82 line to the latest compatible 0.83 release while preserving isolation, Luna/Terra profiles, quotas, nonblocking result delivery, model overrides, and reviewer-submodule rules.
- **Action:** Updated the root Pi AI, coding-agent, and TUI ranges and lockfile to `0.83.0`, aligned TypeBox to `1.3.7`, and confirmed the transitive `pi-agent-core` coupling at `0.83.0`. The installer now installs a Pipi-owned, exact `@earendil-works/pi-coding-agent@0.83.0` runtime under `~/.pipi/agent/npm`, retains it when `--skip-dependencies` is used, and persists exact Pi and MCP adapter dependencies so sequential isolated installs cannot replace the runtime. Added installer coverage for the aligned release family, the isolated runtime, and exact multi-package persistence. No Luna/Terra policy, quota, result-delivery, reviewer-submodule, or model-override value changed.
- **Evidence and affected paths:** Upstream release evidence is [Pi v0.83.0](https://github.com/earendil-works/pi/releases/tag/v0.83.0) and its [TypeBox migration PR](https://github.com/earendil-works/pi/pull/7243). Changed `package.json`, `package-lock.json`, `scripts/install-dependencies.mjs`, `scripts/install.mjs`, `scripts/install.test.mjs`, `README.md`, `SETUP.md`, `extensions/background-terminals/docs/implementation-guide.md`, `docs/pipi-loads-pipi.html`, `docs/pipi-runtime-explained.html`, and this record. The tracked `config/pipi-model-overrides.json` was intentionally unchanged, so no runtime override synchronization was needed.
- **Verification:** Initialized the canonical reviewer submodule and installed worktree dependencies normally. Passed TypeScript, formatting, submodule validation, 21 installer/submodule tests, 129 deterministic non-live extension tests, and 22 file-search tests; paid/live Claude and Codex backend tests were excluded. Public import checks passed for all used Pi API/TUI/AI exports, and a repository scan found no TypeBox APIs removed in 1.3. A disposable isolated installation at `/tmp/pipi-083-installer-smoke` retained exact Pi `0.83.0` and MCP adapter `2.15.0`, then `pipi --version` reported `0.83.0` and `pipi list` reported the expected setup sources. `--list-models` safely reported no authenticated models in the disposable isolated profile; the copied tracked override file remained byte-identical and no live model call was made.
- **Pending:** Review and merge the upgrade pull request. The disposable smoke profile has no authentication by design, so authenticated interactive model selection remains a post-merge local acceptance check.

## Operation entry: isolated npm manifest and install-script policy

- **Request:** Continue the Pi 0.83 flow, merge and test it, then incorporate npm's pending install-script approval guidance into the installer so future npm enforcement cannot disable required runtime/MCP dependency setup.
- **Action:** Merged PR #6 as `4b4e49311bab9064c45c39f828db78a848d6e814`, synchronized `main`, installed the real isolated Pi 0.83 runtime, and found two migration gaps in the installed prefix: the pre-existing MCP dependency remained a caret range and npm reported reviewed install scripts as pending. Added installer policy that repairs non-exact dependency metadata even when installed package bytes already match and replaces any prior approvals with explicit, version-pinned entries only for `@google/genai@1.52.0` and `protobufjs@7.6.5`; arbitrary or legacy pending-script approvals are removed.
- **Affected paths or values:** `scripts/install-dependencies.mjs`, `scripts/install.mjs`, `scripts/install.test.mjs`, `SETUP.md`, and this record. The live isolated npm manifest was explicitly approved for the same two reviewed versions; no auth data or regular Pi state was read or changed.
- **Verification:** The live Pipi runtime reports 0.83.0 and expected Sol/Terra/Luna model metadata. Before remediation, direct manifest inspection reproduced `pi-mcp-adapter: ^2.15.0` and `npm approve-scripts --allow-scripts-pending` listed the two unreviewed scripts. Installer coverage requires exact dependency repair, removal of seeded legacy/unpinned approvals, and the two version-pinned approvals. A disposable full installer run created exact Pi 0.83.0 and MCP adapter 2.15.0 declarations and packages; `npm approve-scripts --allow-scripts-pending` then reported no unreviewed scripts.
- **Pending:** None; PR #7 was merged and the live installer verification is recorded below.
## Operation entry: SageRoute-inspired Luna/Terra delegation review

- **Request:** Read `https://github.com/codejunkie99/sageroute` and think about how Pipi could save more subagent tokens with Luna/Terra and improve delegation prompts.
- **Action:** Reviewed SageRoute's public README, architecture, decision-model, and configuration documentation; inspected local subagent profiles, model quotas, prompt contracts, normalized snapshots/transcripts, context-usage tracking, and automatic result delivery. Started one read-only `luna-explore` and one read-only `terra-audit` analysis for independent recommendations. No runtime, model override, installer, or subagent behavior was changed.
- **Affected paths or values:** Read-only review of `extensions/subagents/src/prompt.ts`, `extensions/subagents/src/policy.ts`, `extensions/subagents/src/domain.ts`, `extensions/subagents/src/backends/pi.ts`, `extensions/subagents/src/manager.ts`, `extensions/subagents/context-usage.test.ts`, `config/pipi-model-overrides.json`, and the SageRoute public documentation. Added this operation record only.
- **Verification:** Confirmed current Pipi environment/model metadata (`PI_MODEL=gpt-5.6-luna`, context overrides Sol 350K and Terra/Luna 300K), confirmed profiles map to `openai-codex/gpt-5.6-luna` and `openai-codex/gpt-5.6-terra` at high reasoning, and confirmed the requested analysis children were launched with read-only profiles and no explicit conflicting overrides. Fresh `npm run check`, `npm run format:check`, `npm run check:submodules`, and `git diff --check` all passed.
- **Pending:** Synthesize the independent Luna/Terra reports; if implementation is desired, design and test a routing/prompt-contract change before modifying runtime behavior. No secrets or auth-file contents were accessed or recorded.

## Operation entry: Terra audit findings incorporated

- **Request:** Incorporate the completed `terra-audit` report into the SageRoute-inspired Luna/Terra delegation review.
- **Action:** Recorded the audit's verified risks and recommendations: read-only profiles are currently advisory because children retain most normal tools; there is no deterministic trajectory/escalation gate, cumulative spend ledger, privacy/redaction boundary, duplicate-delegation suppression, or shared workflow/direct quota; and result truncation from the head can omit conclusions. No runtime files were changed.
- **Affected paths or values:** Findings concern `extensions/subagents/src/policy.ts`, `extensions/subagents/src/backends/pi.ts`, `extensions/subagents/src/manager.ts`, `extensions/subagents/src/domain.ts`, `extensions/subagents/src/format.ts`, `extensions/subagents/src/prompt.ts`, `extensions/subagents/index.ts`, and `extensions/workflows/`. The report stated the checkout was clean and no broad live-backend test suite was run.
- **Verification:** Terra completed a read-only audit with exact path references and reported no file changes. The parent rechecked the documentation-only repository state with `npm run check`, `npm run format:check`, `npm run check:submodules`, and `git diff --check`; all passed.
- **Pending:** Await or independently synthesize the Luna report, then choose whether to implement a bounded first phase: result-contract/redaction and enforced read-only tool policy before trajectory routing and spend accounting.

## Operation entry: Luna design findings incorporated

- **Request:** Incorporate the completed `luna-explore` report into the SageRoute-inspired Luna/Terra delegation review.
- **Action:** Recorded Luna's complementary findings: the parent currently receives final text rather than structured trajectory telemetry; fresh child contexts and generated output are duplicated costs; current context metadata is occupancy rather than cumulative spend; and a compact manager-side trajectory summary is required for reliable SageRoute-style routing. No runtime files were changed.
- **Affected paths or values:** Findings concern `extensions/subagents/src/domain.ts`, `extensions/subagents/src/manager.ts`, `extensions/subagents/src/backends/pi.ts`, `extensions/subagents/src/backends/claude.ts`, `extensions/subagents/src/backends/codex.ts`, `extensions/subagents/index.ts`, `extensions/subagents/src/prompt.ts`, and `config/pipi-model-overrides.json`.
- **Verification:** Luna reported fresh `npm run check`, `npm run format:check`, and `npm run check:submodules` success, inspected implementation and tests without editing files, and avoided the broad live-backend test command. The parent has recorded both independent reports; no secrets or auth-file contents were accessed or recorded.
- **Pending:** If implementation is requested, begin with enforced read-only tool policy and a top-first bounded result contract, then add deterministic trajectory summaries and cumulative delegation budgets. Keep workflows outside shared quota accounting until their aggregate policy is designed.

## Operation entry: deployed isolated npm script policy

- **Request:** Complete the installer remediation for npm lifecycle-script permissions and exact isolated runtime dependency metadata.
- **Action:** Closure-reviewed and squash-merged PR #7 (`e83fe225f1e3c68ecc8f30afb46374658fc96ed5`), then refreshed the live Pipi-owned runtime with `npm run install:pipi`. The installer rewrote the prefix manifest policy and repaired the MCP adapter declaration from a caret range to an exact version.
- **Affected paths or values:** Live `~/.pipi/agent/npm/package.json` now declares exact `@earendil-works/pi-coding-agent: 0.83.0` and `pi-mcp-adapter: 2.15.0`, with only `@google/genai@1.52.0` and `protobufjs@7.6.5` in `allowScripts`. No secrets or authentication data were accessed or recorded.
- **Verification:** Closure review returned `READY`. Passed 133 deterministic extension tests, 22 file-search tests, TypeScript checking, formatting, submodule validation, and `git diff --check`. A disposable full install and the live refresh both produced the exact package declarations and approved-script policy; `npm approve-scripts --prefix ~/.pipi/agent/npm --allow-scripts-pending` reported no unreviewed scripts, and `pipi --version` reported 0.83.0.
- **Pending:** None. npm warnings for unapproved scripts in the repository and unrelated extension development installs remain intentionally outside the isolated Pipi runtime policy.

## Operation entry: subagent prompting-readiness audit

- **Request:** Check `skills/subagents/SKILL.md` and audit the related prompting surfaces for readiness to change.
- **Action:** Performed a read-only audit of the skill, direct-subagent prompt/policy/schema wiring, child profile injection, workflow and summary prompts, public README wording, and deterministic prompt-test coverage. Preserved the pre-existing uncommitted change in `skills/subagents/SKILL.md`; no runtime prompt or policy behavior was changed. A read-only Terra audit was also launched for an independent cross-check.
- **Affected paths or values:** Inspection covered `skills/subagents/SKILL.md`, `extensions/subagents/src/{prompt,policy,backends/pi}.ts`, `extensions/subagents/index.ts`, `extensions/subagents/policy.test.ts`, `extensions/workflows/prompt.ts`, `extensions/summaries/src/prompt.ts`, and `README.md`. This operation record is the only file changed by the audit.
- **Verification:** Confirmed the live direct-subagent schema permits only `luna-explore` and `terra-audit`; profile injection is Pi-only and appends to discovered prompt resources; quotas are Sol=4/Terra=8/Luna=16; and the current skill has a trailing-whitespace diagnostic. The independent Terra audit independently confirmed that `luna-worker` is invalid, Luna profile mutations conflict with its role prompt, profile effort is `high`, direct results require an asynchronous handoff, and direct-tool contract coverage is absent. `npm run check`, `npm run format:check`, and `npm run check:submodules` passed; the full `git diff --check` remains nonzero only for the pre-existing trailing whitespace in `skills/subagents/SKILL.md`.
- **Pending:** Revise the skill to use only supported profiles and non-mutating Luna/Terra roles; decide separately whether to add a mutable worker profile or document explicit Pi/Luna calls. Add direct-tool contract coverage if the registered schema or profile behavior changes.

## Operation entry: Luna worker profile and max reasoning

- **Request:** Add a mutable `luna-worker` direct-subagent profile; make both Luna profiles use `max` reasoning; retain read-only `luna-explore`; and clarify that Terra reviews Luna results after their automatic completion follow-ups arrive.
- **Action:** Added `luna-worker` as a Pi/Luna/max profile authorized for scoped workspace changes and proportionate test execution, while prohibiting commits, pushes, credential changes, unrelated changes, and external-state mutation. Changed `luna-explore` to Pi/Luna/max while retaining its read-only role prompt and adding conclusion-first reporting. Aligned direct-subagent prompt contracts, the registered tool schema, policy/schema tests, the subagents skill, and the public README. The new skill wording makes the Luna-to-Terra handoff explicitly sequential across parent turns; workflow behavior and model overrides remain unchanged.
- **Affected paths or values:** `extensions/subagents/src/policy.ts`, `extensions/subagents/src/prompt.ts`, `extensions/subagents/index.ts`, `extensions/subagents/policy.test.ts`, `extensions/subagents/spawn-contract.test.ts`, `skills/subagents/SKILL.md`, `README.md`, and this record. Luna profile reasoning is now `max`; Terra remains `high`.
- **Verification:** Focused policy/schema tests passed (7 tests); TypeScript, extension formatting, and submodule validation passed. The deterministic non-live extension suite passed 130 tests, installer/submodule tests passed 22 tests, and file-search tests passed 22 tests. Paid/live Claude and Codex backend tests were not run. The required independent initial review returned `READY` with no findings, so closure review was not required. No runtime model override synchronization was needed because context-window values did not change.
- **Pending:** None. Reload or start a new Pipi session before using the new model-facing profile guidance.

## Operation entry: Luna worker profile pull request

- **Request:** Create a pull request for the Luna worker profile implementation.
- **Action:** Moved the completed change from the primary `main` checkout into `.worktrees/feat-luna-worker-profile` on `feat/luna-worker-profile`, committed it as `412a5cc` (`feat(subagents): add luna worker profile`), pushed it to `origin`, and opened PR [#9](https://github.com/blockedby/my-pi-setup/pull/9) against `blockedby/my-pi-setup` `main`. Prepared the feature branch against `origin/main`; rebase was a no-op and GitHub reports the PR open, clean, and not a draft.
- **Affected paths or values:** The feature worktree and branch contain the Luna profile implementation. The primary checkout remains on a clean `main`; no runtime Pipi configuration, authentication data, or model override changed.
- **Verification:** Initialized the existing pinned reviewer submodule in the new worktree without advancing it, installed ignored worktree dependencies, and reran TypeScript, formatting, submodule validation, 130 deterministic non-live extension tests, 22 installer/submodule tests, 22 file-search tests, and diff checks successfully. The initial worktree submodule check and installer tests failed before initialization, then passed after the prescribed `git submodule update --init --recursive`; paid/live backend tests were not run.
- **Pending:** Review and merge PR #9 when authorized. Reload or start a new Pipi session after merge before using the new model-facing profile guidance.

## Operation entry: merged Luna worker profile and synchronized main

- **Request:** Merge PR #9, synchronize the local checkout with the remote, then report the result.
- **Action:** Squash-merged PR #9 as `d346e13f5206ee26947ce221018da2c4dd59e9aa`, fast-forwarded local `main` to the same commit, and retained the remote feature branch. The prescribed target-sync helper could not remove the feature worktree because it contained the initialized reviewer submodule. After deinitializing that worktree-local submodule without advancing its pin, removed the clean worktree manually, pruned its Git metadata, and deleted the local feature branch.
- **Affected paths or values:** Local and `origin/main` now contain the merged Luna-worker implementation; the primary checkout is `/home/kcnc/code/tools/pipi-alias` on `main`. The removed local worktree was `.worktrees/feat-luna-worker-profile`; the remote `feat/luna-worker-profile` branch remains. No Pipi runtime setting, model override, or authentication data changed.
- **Verification:** GitHub reports PR #9 `MERGED` at `d346e13`; local `HEAD` and `origin/main` matched immediately after synchronization, and the primary checkout was clean. The feature branch was clean before removal; the canonical reviewer submodule pin remained `81053d6a05f2160341582d2eacf30cbc9f2c3bd5`. Existing PR verification covered TypeScript, formatting, submodule validation, 130 deterministic non-live extension tests, 22 installer/submodule tests, 22 file-search tests, and independent review `READY`.
- **Pending:** Reload or start a new Pipi session before using the newly merged model-facing profile guidance.

## Operation entry: refreshed local Pipi after Luna worker merge

- **Request:** After merging PR #9 and synchronizing local `main`, confirm whether the local Pipi setup is updated.
- **Action:** Ran `npm run install:pipi -- --skip-dependencies` from synchronized `main`. The isolated launcher and package registration remain configured to load `/home/kcnc/code/tools/pipi-alias`, which now contains the merged Luna-worker profile. No dependency, model-override, authentication, or regular-Pi setting changed.
- **Affected paths or values:** The isolated launcher remains `/home/kcnc/.local/bin/pipi`; Pipi runtime remains `@earendil-works/pi-coding-agent@0.83.0`; package sources remain the creator checkout, sibling `pi-codex`, and `npm:pi-mcp-adapter@2.15.0`.
- **Verification:** Installer completed successfully with `--skip-dependencies`; `pipi --version` reports `0.83.0`; `pipi list` reports the expected three package sources including `/home/kcnc/code/tools/pipi-alias`. No live model or authentication action was invoked.
- **Pending:** Reload the currently running Pipi session or start a new one so its already-built model prompt includes `luna-worker` and the Luna `max` guidance.

## Operation entry: live Luna worker acceptance verification

- **Request:** Verify the merged and refreshed local Pipi setup with subagents.
- **Action:** Ran a bounded no-session Pipi smoke prompt that called `subagent_spawn` once with only `profile: "luna-worker"`, a non-mutating child task, and no explicit harness/model/effort override. It accepted the profile and resolved it to Pi with `openai-codex/gpt-5.6-luna`. Also launched independent read-only Luna and Terra acceptance audits over the merged workspace and isolated Pipi installation.
- **Affected paths or values:** Verification-only inspection of the merged subagent policy, schema, prompts, skill, README, isolated Pipi package configuration, and model catalog. This operation record is the only repository file changed; no runtime setting, model override, or authentication data changed.
- **Verification:** The live smoke tool result returned `sa-1` with Pi/Luna; the child task explicitly prohibited mutation. Both independent audits confirmed Pi/Luna/max profiles, schema exposure, consistent guidance, expected isolated Pipi package source/version `0.83.0`, and a clean synchronized checkout. Terra returned `PASS`; Luna returned `CONDITIONAL PASS` solely because worker commit/push/credential restrictions are intentional role-prompt guidance rather than technical tool restrictions. Fresh targeted policy/schema tests passed 7/7; TypeScript, formatting, submodule validation, and diff checks passed. Luna accidentally ran a wildcard test command that included two out-of-scope live Claude tests, which failed; those failures are not acceptance evidence for the Pi/Luna profile and were not rerun.
- **Pending:** No change is required for the accepted prompt-guided worker boundary. Do not use the broad `extensions/subagents/*.test.ts` wildcard without explicit live Claude/Codex test authorization; keep deterministic tests excluding `claude.test.ts` and `codex.test.ts` as the routine check.

## Operation entry: tracked subagent follow-up proposals

- **Request:** Record the current reasoning and proposals for the context gauge and stronger runtime-first Luna orchestration in a GitHub issue, then extend it later.
- **Action:** Created [issue #10](https://github.com/blockedby/my-pi-setup/issues/10), `Track subagent context saturation and runtime-first Luna delegation`. It records the evidence that `100%/300k` currently hides real over-capacity usage, the minimal `>100%` display proposal and test plan, plus the `delegate_investigation`/`luna_explore` runtime-tool proposal, soft-gate alternative, automatic-spawn risks, and open design questions. No implementation was made.
- **Affected paths or values:** GitHub issue #10 and this durable record only; no runtime setting, model override, package, credential, or product-code change.
- **Verification:** Confirmed no duplicate open context issue before creation; GitHub returned the issue URL. The issue intentionally notes that broad wildcard tests can invoke live backend tests and should not be the default verification route.
- **Pending:** Add the outstanding Luna context and delegation-policy reports to issue #10, then choose a bounded implementation phase.

## Operation entry: Luna context trace added to issue #10

- **Request:** Add the arriving agent findings to the tracked GitHub issue as they become available.
- **Action:** Added [issue comment `#issuecomment-5189528977`](https://github.com/blockedby/my-pi-setup/issues/10#issuecomment-5189528977) reconciling both context-gauge traces. The screenshot-correlated sessions genuinely exceeded 300k and need an explicit `>100%` display; a separate Pi `null`-usage propagation path can retain stale pre-compaction tokens and needs correction/test coverage. No implementation was made.
- **Affected paths or values:** GitHub issue #10 and this durable record only; no runtime setting, model override, package, credential, or product-code change.
- **Verification:** The comment records the exact type/event/manager boundaries, preserves the current occupancy formula, and separates screenshot-proven saturation from the independent stale-usage edge. Both source audits were read-only.
- **Pending:** Add the outstanding Luna runtime-orchestration design report to issue #10, then choose a bounded implementation phase.

## Operation entry: Luna runtime-orchestration design added to issue #10

- **Request:** Add the outstanding runtime-first Luna orchestration design report to the tracked GitHub issue.
- **Action:** Added [issue comment `#issuecomment-5189567344`](https://github.com/blockedby/my-pi-setup/issues/10#issuecomment-5189567344). It proposes a hybrid first phase: explicit model-facing Luna-first thresholds plus a narrow deterministic `tool_call` gate that redirects broad repository exploration to an explicit `luna-explore` spawn. It deliberately avoids automatic model spawning, blocking ordinary local/integration work, workflow changes, and waiting for child completion.
- **Affected paths or values:** GitHub issue #10 and this durable record only; no runtime setting, model override, package, credential, or product-code change.
- **Verification:** The read-only design review inspected the current subagent extension boundary and Pi 0.83 event capabilities, found that `tool_call` preflight can block high-confidence exploration calls, and returned a deterministic test plan. No live model was invoked by the reviewer.
- **Pending:** Choose whether to implement the bounded hybrid gate. The independently identified context-gauge display/null-propagation fixes remain separately unimplemented in issue #10.

## Operation entry: verified context-gauge root cause added to issue #10

- **Request:** Establish confidence in the cause of high subagent context occupancy and retain the reasoning in the GitHub issue.
- **Action:** Added [issue comment `#issuecomment-5193981928`](https://github.com/blockedby/my-pi-setup/issues/10#issuecomment-5193981928). An independent read-only audit matched the screenshot's three Luna JSONL sessions: at the screenshot elapsed time (`3m37s`), all had raw native context totals of `304,865–320,123` against a `300,000` capacity before compaction. The existing formatter caps them to `100%`. It also preserved the separate post-compaction `null`-usage/stale-label edge as a secondary bug.
- **Affected paths or values:** GitHub issue #10 and this durable record only; no runtime setting, model override, package, credential, or product-code change.
- **Verification:** The audit cross-checked session timestamps, raw native totals, compaction ordering, Pi 0.83 forwarding, and the formatter cap. A follow-up read-only Luna trace was started to attribute token growth to message/tool-result sizes without exposing their contents or calling a live model.
- **Pending:** Receive and add the token-growth accounting trace. Decide separately on the context display/null fixes and on a less brittle Luna-first orchestration design.

## Operation entry: non-blocking Luna advisory design added to issue #10

- **Request:** Examine repository topology for a clearer way to steer the model toward subagents during long-file or broad-codebase investigation, without a vague hard gate or necessarily adding a new tool.
- **Action:** Added [issue comment `#issuecomment-5194078486`](https://github.com/blockedby/my-pi-setup/issues/10#issuecomment-5194078486). The topology review found no existing automatic router, but found the existing Luna-first profile, prompt guidance, spawn/result delivery, and bounded search mechanisms. It replaces the proposed second-file hard gate with a non-blocking, deduplicated `tool_result` advisory triggered only by actual truncation/broad-result metadata.
- **Affected paths or values:** GitHub issue #10 and this durable record only; no runtime setting, model override, package, credential, or product-code change.
- **Verification:** The read-only review covered subagent, workflow, file-search, summary, background-terminal, shared-helper, and installed Pi-extension patterns. It identified deterministic tests and corrected the generic `npm test` suggestion: root test runs may invoke live Claude/Codex tests and are not routine verification.
- **Pending:** Receive and add the token-growth accounting trace. Decide whether to implement the evidence-triggered Luna advisory, separately from the context display/null-propagation fixes.

## Operation entry: token-growth accounting added to issue #10

- **Request:** Establish the concrete cause of the high Pi/Luna context totals and add the completed forensic trace to the GitHub record.
- **Action:** Added [issue comment `#issuecomment-5194146054`](https://github.com/blockedby/my-pi-setup/issues/10#issuecomment-5194146054). It attributes the saturation to 104–130 retained tool results per child (about 1.49–1.74 MB serialized and 333k–352k estimated content tokens), their repeated cached-prefix reuse, and Pi 0.83 compaction occurring only after an enclosing tool-use loop. It found no Pi token arithmetic double-counting and confirmed post-compaction totals reset.
- **Affected paths or values:** GitHub issue #10 and this durable record only; no runtime setting, model override, package, credential, or product-code change.
- **Verification:** The read-only trace correlated timestamped native usage components, preceding event types/record lengths, compaction `tokensBefore` estimates, and post-compaction reset behavior. It deliberately did not reveal tool-result contents or invoke live models.
- **Pending:** Decide whether to implement the context display/null-propagation fixes. Refine and validate an evidence-triggered Luna advisory for repeated/broad-result accumulation as well as explicit truncation before implementation.

## Operation entry: nested-subagent readiness audit

- **Request:** Assess how ready the repository is for subagents to create their own subagents.
- **Action:** Audited the direct-subagent child tool policy, Pi/Claude/Codex backend boundaries, manager ownership and quotas, result delivery, cancellation and shutdown, lineage metadata, UI, workflows, documentation, and deterministic tests. No product behavior was changed. A read-only Luna cross-check was attempted but produced no report because the provider returned an overload error.
- **Affected paths or values:** Read-only inspection covered `extensions/shared/child-session.ts`, `extensions/subagents/`, `extensions/workflows/`, `skills/subagents/SKILL.md`, and existing documentation. This operation record is the only changed repository path; no model override, runtime setting, package, or authentication data changed.
- **Verification:** Fresh TypeScript checking passed. The focused deterministic child-policy, subagent manager/policy/delivery/schema/UI suite passed 28/28 tests. Static evidence confirms that Pi children explicitly exclude all subagent-management and workflow tools, Claude disables native Agent/Task tools, quotas and IDs are local to each manager instance, snapshots contain no parent/depth/root lineage, and current settlement delivery is turn-based rather than subtree-based.
- **Pending:** Before enabling nesting, define a bounded tree contract: supported harness direction, maximum depth/fan-out, shared root quotas and spend budget, lineage and globally unique IDs, subtree cancellation/cleanup, terminal-result semantics, capability/trust inheritance, root-visible UI, and nested integration tests. The recommended first implementation is Pi-only, one nested level, with a shared root coordinator; merely removing `subagent_spawn` from the denylist is unsafe.

## Operation entry: issue #10 implementation plan

- **Request:** Use subagents to produce an implementation plan for issue #10.
- **Action:** Fanned planning out to three read-only Luna agents for context correctness, passive Luna steering, and PR sequencing, then routed the combined proposal through a read-only Terra audit. Added the reduced two-PR plan to [issue comment `#issuecomment-5278193898`](https://github.com/blockedby/my-pi-setup/issues/10#issuecomment-5278193898): PR1 corrects overflow/null occupancy state; PR2 optionally adds one metadata-triggered, non-blocking Luna advisory per parent run.
- **Affected paths or values:** GitHub issue #10 and this durable record only; no runtime behavior, model override, dependency, package, credential, or product code changed.
- **Verification:** All four planners were read-only and used no live Claude/Codex backend tests. Terra verified the current Pi event/result contracts and removed unnecessary shared-formatter/workflow scope, compaction-start events, child markers, telemetry, arbitrary thresholds, history tracking, hard gates, and auto-spawning from v1.
- **Pending:** Implement PR1 independently. Implement PR2 only after product approval for its passive model-visible advisory. After each substantial implementation, run focused deterministic checks and the canonical initial/closure reviewer workflow.

## Operation entry: subagent context occupancy correctness implementation

- **Request:** Implement both approved issue #10 changes in parallel; this branch contains the context-occupancy correctness slice.
- **Action:** Updated `/subagents` usage normalization and display so explicit Pi unknown usage survives as `null`, omitted samples retain prior state, exact capacity remains `100%`, raw overflow renders `>100%`, and successful Pi compaction completion refreshes current usage. Added focused formatter, manager, adapter, and compaction-refresh regression coverage.
- **Affected paths or values:** `extensions/subagents/src/{domain,format,manager}.ts`, `extensions/subagents/src/backends/pi.ts`, `extensions/subagents/{format,manager,pi-context}.test.ts`, and its deterministic package test script. No model override, dependency, credential, workflow formatter, compaction policy, or live backend changed.
- **Verification:** The updated subagents deterministic suite passed 33/33; TypeScript, formatting, submodule, installer, file-search, and `git diff --check` checks passed. Canonical initial review returned `READY` with no findings. No root/live Claude/Codex tests were run.
- **Pending:** PR #11 is open to `main`; merge only after authorization, reinstall/reload Pipi after merge, and verify the runtime display.

## Operation entry: passive Luna delegation advisory implementation

- **Request:** Implement both approved issue #10 changes in parallel; this branch contains the passive Luna advisory slice.
- **Action:** Added a maximum-once-per-parent-run `tool_result` advisory that preserves original result content and recommends a self-contained `luna-explore` spawn only when supported read/search metadata explicitly reports truncation or a reached built-in result limit. The behavior is bypassed when `subagent_spawn` is inactive and resets when the parent run settles or the session shuts down. Updated model-facing prompt and skill guidance.
- **Affected paths or values:** `extensions/subagents/src/delegation-advisor.ts`, `extensions/subagents/delegation-advisor.test.ts`, `extensions/subagents/index.ts`, `extensions/subagents/src/prompt.ts`, `extensions/subagents/package.json`, and `skills/subagents/SKILL.md`. No new tool, hard gate, auto-spawn, extra turn, telemetry, model override, dependency, credential, or child-session marker was added.
- **Verification:** The updated subagents deterministic suite passed 28/28; file-search passed 22/22; TypeScript, formatting, submodule, installer, and `git diff --check` checks passed. The canonical initial review identified omitted Pi `grep.details.linesTruncated` handling; the classifier and retained regression test were corrected, the same checks passed again, and closure review marked `REV-001` fixed with a `READY` verdict. No root/live Claude/Codex tests were run.
- **Pending:** Open the PR to `main`, merge only after authorization, reinstall/reload Pipi after merge, and verify advisory injection with deterministic/runtime-safe evidence.

## Operation entry: issue #10 implementation merged and installed

- **Request:** Implement both approved issue #10 changes in parallel and merge both after review.
- **Action:** Merged [PR #11](https://github.com/blockedby/my-pi-setup/pull/11) for context occupancy correctness, rebased the independent advisory branch onto the resulting `main`, resolved only the combined deterministic test script and operation-record conflicts, reran integration checks, then merged [PR #12](https://github.com/blockedby/my-pi-setup/pull/12). Reinstalled the repository into Pipi with `npm run install:pipi -- --skip-dependencies`; the installed runtime remains `0.83.0`. Closed [issue #10](https://github.com/blockedby/my-pi-setup/issues/10) as completed. Local feature worktrees and branches were removed; remote feature branches were retained by policy.
- **Affected paths or values:** Main product behavior now includes `/subagents` `?%`/`100%`/`>100%` occupancy states, explicit Pi null propagation and successful-compaction refresh, plus one passive truncation-triggered Luna advisory per parent run. Runtime installation refreshed `/home/kcnc/.local/bin/pipi` and Pipi-managed settings/resources without changing model overrides, credentials, dependencies, auth sharing, workflows, or compaction policy.
- **Verification:** On merged `main`, the combined deterministic subagents suite passed 37/37, file-search passed 22/22, installer tests passed 22/22, and TypeScript, formatting, submodule, and `git diff --check` checks passed. PR #11 canonical review was `READY` with no findings; PR #12 closure review marked `REV-001` fixed and returned `READY`. Both PRs are confirmed merged, local `HEAD` equals `origin/main`, and `pipi --version` reports `0.83.0`. No root/live Claude/Codex tests were run.
- **Pending:** Reload or restart any Pipi session that was already running before installation. A future live truncated-result occurrence can provide an optional runtime UX observation; deterministic contracts already cover result preservation and advisory injection.

## Operation entry: Pi 0.84.1 upgrade

- **Request:** Upgrade the isolated Pipi runtime from Pi 0.83.0 to 0.84.1 after the runtime reported the available update.
- **Action:** Updated the aligned root `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` ranges and lockfile to 0.84.1; updated installer alignment assertions and the background-terminal implementation reference. Reviewed the 0.84.0 breaking changes and 0.84.1 release notes. This repository does not use the renamed `ModelsStreamTransforms`, removed agent-core experimental/base entrypoints, handwritten provider-refresh store API, or JSON/RPC cumulative message fields; existing extension event code uses `assistantMessageEvent` deltas. The repository-pinned isolated runtime must be upgraded through this manifest and installer rather than standalone `pi update`.
- **Affected paths or values:** `package.json`, `package-lock.json`, `scripts/install.test.mjs`, `extensions/background-terminals/docs/implementation-guide.md`, and this record. The target isolated runtime is exact `@earendil-works/pi-coding-agent@0.84.1`; TypeBox remains `1.3.7`, MCP remains `pi-mcp-adapter@2.15.0`, and model overrides, auth, profiles, quotas, submodule pin, and regular Pi are unchanged.
- **Verification:** Upstream evidence: [Pi 0.84.1](https://pi.dev/news/releases/0.84.1) and [Pi 0.84.0](https://pi.dev/news/releases/0.84.0). Fresh dependencies installed and TypeScript/formatting passed against 0.84.1. Deterministic checks passed: 22 installer/submodule tests, 37 subagent tests, 22 file-search tests, and 99 remaining extension tests; submodule validation and diff checks passed. A disposable isolated installation at `/tmp/pipi-0841-home` created exact Pi `0.84.1` and MCP adapter `2.15.0` declarations, left no unreviewed install scripts, and its launcher reported `0.84.1` plus the expected package sources. Canonical initial review returned `READY` with no findings and confirmed direct callers conform to 0.84 delta/header APIs. No live model call or auth data access was performed.
- **Pending:** Open and merge the upgrade PR, install the exact isolated 0.84.1 runtime in the real Pipi prefix, verify `pipi --version`, and reload/restart existing sessions.

## Operation entry: Pi 0.84.1 rollout completed

- **Request:** Finish the requested isolated Pipi upgrade to Pi 0.84.1.
- **Action:** Squash-merged [PR #13](https://github.com/blockedby/my-pi-setup/pull/13), synchronized `main`, removed the local feature worktree/branch while retaining the remote branch, and ran the full real `npm run install:pipi`. The isolated prefix upgraded from exact Pi 0.83.0 to exact `@earendil-works/pi-coding-agent@0.84.1`; package registration, MCP 2.15.0, reviewed lifecycle-script policy, and auth isolation were retained.
- **Affected paths or values:** Live `/home/kcnc/.pipi/agent/npm/package.json` now declares exact Pi `0.84.1` and MCP adapter `2.15.0`; `/home/kcnc/.local/bin/pipi` launches the upgraded isolated runtime. The runtime copy `/home/kcnc/.pipi/agent/models.json` remains byte-identical to `config/pipi-model-overrides.json`. No credential/auth file, regular Pi state, model override value, submodule pin, profile, or quota changed.
- **Verification:** `pipi --version` and the installed coding-agent package both report `0.84.1`; `pipi list` reports the creator checkout, `pi-codex`, and MCP adapter sources; the isolated manifest has only exact runtime/MCP dependencies and the two reviewed install-script approvals, with no unreviewed scripts. Fresh merged-main checks passed: 37/37 subagent tests, 22/22 installer tests, 22/22 file-search tests, TypeScript, formatting, submodule validation, and `git diff --check`. Canonical review was `READY` with no findings; no live model call was made.
- **Pending:** Reload or restart any Pipi session that started before this rollout so it loads Pi 0.84.1.

## Operation entry: Luna exploration and advisory live acceptance

- **Request:** Verify that the installed `luna-explore` profile works and that truncation advisories are actually shown to the model and acted upon.
- **Action:** Ran two bounded Pipi 0.84.1 live smokes in `/tmp/pipi-luna-smoke`. The first made Sol read a 2,501-line file: the read result was truncated at 2,000 lines, included the exact passive Pipi advisory, and Sol followed it by calling `subagent_spawn` with `profile: "luna-explore"`. The second used RPC mode to keep the parent alive through asynchronous completion and automatic follow-up delivery.
- **Affected paths or values:** Temporary smoke files and disposable child session evidence only; this operation record is the only repository change. No product code, model override, setting, credential, auth file, package, profile, quota, or persistent test fixture changed.
- **Verification:** The first result contained the advisory and accepted `sa-1` as Pi `openai-codex/gpt-5.6-luna`. In the full-cycle RPC smoke, `sa-1` completed read-only, automatically delivered `Conclusion: LINE-0001 marker-1; LINE-2501 marker-2`, and triggered a second parent turn that repeated the correct conclusion. No polling/wait tool was used. Focused deterministic advisory/profile/schema tests also passed 11/11.
- **Pending:** None. Existing Pipi sessions created before the runtime/extension rollout still require reload or restart.

## Operation entry: eight-way delegation and workflow concurrency

- **Request:** Explain why Pipi tends to delegate to four subagents, then raise both the automatic direct-Luna delegation recommendation and workflow parallelism to eight.
- **Action:** Identified the soft four-worker recommendation in `skills/subagents/SKILL.md` separately from the direct model quotas and the workflow hard cap. Changed the recommendation to eight independent Luna workers; raised both the workflow host controller and sandbox `parallel()` default/maximum from four to eight; aligned the workflow tool description and explanatory HTML; and added deterministic host-controller and sandbox fanout coverage. Direct quotas remain Sol=4, Terra=8, Luna=16, with the non-Pi aggregate unchanged at four.
- **Affected paths or values:** `skills/subagents/SKILL.md`, `extensions/workflows/controller.ts`, `extensions/workflows/sandbox-child.cjs`, `extensions/workflows/prompt.ts`, `extensions/workflows/controller.test.ts`, `extensions/workflows/sandbox.test.ts`, `docs/subagents-explained.html`, and this record. Workflow total calls per run remain capped at 32; model context-window overrides, credentials, submodule pin, and installed dependencies were not changed.
- **Verification:** Focused workflow tests passed 24/24. The full repository run passed 22 installer/submodule tests, 148 extension tests, and 22 file-search tests; TypeScript, formatting, submodule validation, and `git diff --check` passed. The full extension command also exercised and passed the configured live Claude/Codex backend tests. A canonical read-only initial review was launched against the working-tree diff.
- **Review:** Canonical initial review returned `NOT_READY` with `REV-001` (one remaining explanatory statement still claimed a fixed four-worker limit) and `REV-002` (the host fanout test derived its expected peak from the production constant instead of independently requiring eight). Remediation now states that workflow fanout is eight while direct limits are model-specific, and asserts both the exported host cap and observed peak against literal eight.
- **Closure:** Focused remediation checks passed: workflow tests 24/24, TypeScript, changed-file formatting, obsolete-text search, and `git diff --check`. Canonical closure review marked `REV-001` and `REV-002` fixed and returned `READY` with no findings. A later repository-wide formatting check was blocked only by unrelated concurrently created untracked `scripts/pipi-version.mjs`; this operation did not inspect beyond formatting output, edit, or remove that file, and the earlier full formatting check plus all changed-file checks passed.
- **Pending:** Reload or restart Pipi so the current process loads the new skill and workflow extension code.

## Operation entry: Pi 0.84.2 upgrade automation and rollout

- **Request:** Update Pipi to 0.84.2, create a repository-level skill for future upgrades, and add repeatable scripts that simplify the process.
- **Action:** Updated the aligned `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` ranges and lockfile to 0.84.2. Added a deliberately short repository-level `.agents/skills/update-pipi` skill that runs three commands: conditional changelog review, dependency update, and complete verification/rollout. The changelog script uses `curl` only for forward minor or major upgrades, prints all release sections through the target, and highlights `Breaking Changes`; patch upgrades skip the fetch. Added registry-preflight/explicit lockfile-pin/rollback, source-verification, installed-runtime verification, focused version/changelog tests, and a deterministic test runner that excludes explicitly live Claude/Codex backend tests. Installer alignment tests now derive the pinned version from `package.json`, reducing manual edits on later upgrades. Reviewed the Pi 0.84.2 release notes and coding-agent changelog; its additions and fixes do not require changes to the repository's existing extension imports or event contracts.
- **Affected paths or values:** `.agents/skills/update-pipi/SKILL.md`, `scripts/{check-pipi-changelog,update-pipi-version,check-pipi-version,check-pipi-install,pipi-version,run-deterministic-tests}.mjs`, `tests/scripts/pipi-version.test.mjs`, `tests/scripts/install.test.mjs`, `package.json`, `package-lock.json`, `SETUP.md`, `extensions/background-terminals/docs/implementation-guide.md`, and this record. The target isolated runtime is exact Pi 0.84.2; MCP remains 2.15.0. Model overrides, auth isolation, profiles, quotas, and the reviewer submodule pin are unchanged. Unrelated concurrent eight-way workflow/delegation changes already present in the working tree were preserved.
- **Release evidence:** [Pi 0.84.2 release notes](https://pi.dev/news/releases/0.84.2) and npm metadata confirmed all three aligned packages at 0.84.2 with Node `>=22.19.0`; the current environment uses Node 24.19.0.
- **Verification:** The three-command maintenance path was exercised against 0.84.2: conditional changelog check, explicit update, complete deterministic verification, rollout, and installed-state verification. The final full run passed 28 installer/version/changelog/submodule tests, 144 deterministic extension tests, and 22 file-search tests while explicitly excluding live Claude/Codex backend files. TypeScript, Pi-version alignment, installed-state validation, submodule validation, repository formatting, and `git diff --check` passed. The real isolated installation completed: `pipi --version` and the installed coding-agent package report 0.84.2; `pipi list` reports the expected checkout, `pi-codex`, and MCP sources; the isolated manifest pins exact Pi 0.84.2 and MCP 2.15.0 with only the two reviewed lifecycle-script approvals; npm reports no unreviewed scripts; the runtime model override remains byte-identical to the tracked copy; and regular `pi` remains 0.82.1. No live model/backend test or authentication-data access was performed by the implementation checks.
- **Review:** The first canonical review attempt hit provider overload. The retry returned `NOT_READY` with `REV-001`: an unqualified npm lockfile regeneration could select a later compatible patch and then fail exact-target validation. Remediation now passes all three explicit target package specs while preserving caret declarations and retains a deterministic regression test that models a newer compatible patch. Canonical closure marked `REV-001` fixed and returned `READY` with no findings.
- **Pending:** Reload or restart sessions created before the upgrade so they use Pi 0.84.2; future upgrades in this repository can invoke `/skill:update-pipi`.

## Operation entry: pushed Pi 0.84.2 and workflow fanout changes

- **Request:** Commit and push the completed local changes.
- **Action:** Moved the cleanly reviewed working-tree changes from the primary `main` checkout into `.worktrees/pipi-0842-upgrade-and-workflow-fanout` on `feat/pipi-0842-upgrade-and-workflow-fanout`, committed them as `209f27b` (`feat: automate Pipi upgrades and increase workflow fanout`), pushed the branch to `origin`, and opened [PR #14](https://github.com/blockedby/my-pi-setup/pull/14) against `blockedby/my-pi-setup` `main`. The target-branch preparation helper reported the branch up to date with `origin/main`, no conflict, no content change, and no regression rerun requirement.
- **Affected paths or values:** The pushed branch contains the reviewed Pi 0.84.2 runtime/upgrade automation and the independently reviewed eight-way workflow fanout changes. The primary `main` checkout is clean and remains at `dccc487`; the real isolated Pipi runtime remains 0.84.2. The verified transfer stash was dropped after the feature worktree and remote branch matched.
- **Verification:** In the feature worktree, 28 installer/version/changelog/submodule tests, 144 deterministic extension tests, and 22 file-search tests passed. Pi version/install checks, TypeScript, formatting, submodule validation, and `git diff --check` passed. Both canonical review tracks ended `READY` with no open findings.
- **Pending:** PR #14 is open, clean, and has no configured status checks. Review and merge remain separate user decisions.

## Operation entry: separated script tests

- **Request:** Move all script tests into a separate folder.
- **Action:** Moved the submodule-checker, installer, and Pipi-version test files from `scripts/` to `tests/scripts/`; updated their repository-root resolution and production-script imports; changed `test:installer` to discover `tests/scripts/*.test.mjs`; and added the new test directory to formatting commands.
- **Affected paths or values:** `tests/scripts/check-submodules.test.mjs`, `tests/scripts/install.test.mjs`, `tests/scripts/pipi-version.test.mjs`, `package.json`, current path references in this record, and the removed former test paths under `scripts/`. Production scripts and runtime behavior are unchanged.
- **Verification:** The moved script suite passed 28/28 both directly and through the full deterministic command; 144 extension tests and 22 file-search tests also passed. TypeScript, Pi-version alignment, formatting including `tests/**/*.mjs`, submodule validation, `git diff --check`, and an explicit check that no `*.test.mjs` files remain directly under `scripts/` passed.
- **Pending:** PR #14 remains open for review and merge after this test-layout follow-up.

## Operation entry: merged PR #14 and refreshed local Pipi

- **Request:** Merge PR #14 and update the local checkout and Pipi setup.
- **Action:** Squash-merged [PR #14](https://github.com/blockedby/my-pi-setup/pull/14) into `main` as `34a47b9afbe8bc49810b0ed247ec158e4d0f8e6e`, synchronized the primary checkout to the same `origin/main` commit, removed the merged feature worktree and local branch, retained the remote feature branch, reinitialized the canonical reviewer submodule at its unchanged pin, and refreshed the isolated Pipi setup with `npm run install:pipi -- --skip-dependencies`. The sync helper updated `main` but could not remove a worktree containing an initialized submodule; cleanup completed after deinitializing that worktree and forcing removal of the verified clean worktree.
- **Affected paths or values:** Local `main` and `origin/main` contain Pi 0.84.2 upgrade automation, eight-way workflow fanout, and script tests under `tests/scripts/`. The isolated launcher remains `/home/kcnc/.local/bin/pipi`, exact runtime remains 0.84.2, MCP remains 2.15.0, and model overrides remain unchanged. No credential or auth-file content was accessed.
- **Verification:** GitHub reports PR #14 merged. Local `HEAD` equals `origin/main`; the primary checkout is clean; the merged feature worktree/local branch are absent; and the canonical submodule is initialized at `81053d6a05f2160341582d2eacf30cbc9f2c3bd5`. Fresh merged-main checks passed 28 script/installer/submodule tests, 144 deterministic extension tests, 22 file-search tests, TypeScript, formatting, submodule validation, Pi source/install validation, and `git diff --check`. `pipi --version` reports 0.84.2.
- **Pending:** Reload or restart Pipi sessions created before this merge so they load the merged skill, workflow, and test-layout changes.

## Operation entry: isolated eight-way delegation and workflow fanout

- **Request:** Raise the automatic Luna delegation recommendation and workflow parallelism from four to eight, then place only that change in a separate worktree and open a pull request.
- **Action:** Created `.worktrees/eight-way-subagent-fanout` on `feat/eight-way-subagent-fanout` from `origin/main` and transferred only the independently reviewed fanout implementation, tests, skill guidance, and explanatory documentation. The workflow host controller and sandbox `parallel()` default/maximum are eight; direct quotas remain Sol=4, Terra=8, Luna=16, and the non-Pi aggregate remains four. The separate Pi 0.84.2 upgrade/automation files from PR #14 were intentionally excluded.
- **Affected paths or values:** `skills/subagents/SKILL.md`, `extensions/workflows/controller.ts`, `extensions/workflows/sandbox-child.cjs`, `extensions/workflows/prompt.ts`, `extensions/workflows/controller.test.ts`, `extensions/workflows/sandbox.test.ts`, `docs/subagents-explained.html`, and this record. Workflow calls per run remain capped at 32; model overrides, runtime package versions, installer code, credentials, and submodule pin are unchanged.
- **Verification:** The original exact implementation passed canonical closure review (`READY`, both prior blockers fixed). Before PR #14 merged, isolated-worktree checks passed 22 installer/submodule tests, 144 deterministic non-live extension tests including 24/24 workflow tests, and 22 file-search tests; TypeScript, repository formatting, submodule validation, and `git diff --check` passed.
- **Pull request:** Committed and pushed the isolated implementation, then opened [PR #15](https://github.com/blockedby/my-pi-setup/pull/15) against `blockedby/my-pi-setup` `main`. PR #14 subsequently merged the same reviewed product changes into `main` together with the Pi 0.84.2 work.
- **Preparation:** Rebasing PR #15 after PR #14 produced one conflict only in this operation record; all product, test, skill, and explanatory-document changes were already byte-equivalent upstream and required no resolution. Preserved the complete merged-main history plus this isolated-PR record. The rebased PR #15 diff now contains only this durable record, with no duplicate runtime or test change.
- **Post-rebase verification:** Fresh checks passed 28 script/installer/submodule tests, 144 deterministic extension tests, and 22 file-search tests; TypeScript, Pipi version/install checks, formatting, submodule validation, and `git diff --check` passed.
- **Pending:** Push the rebased branch with lease, merge PR #15 as authorized, synchronize and clean up the local feature worktree/branch, and reload or restart any stale Pipi session.

## Operation entry: plan-gh-backlog submodule integration

- **Request:** In a new `pipi-alias` worktree, integrate the `plan-gh-backlog` skill as a Git submodule, install it for Pipi, and open a pull request to `main`.
- **Action:** Created `.worktrees/plan-gh-backlog-skill` on `feat/plan-gh-backlog-skill`; added `https://github.com/blockedby/plan-gh-backlog.git` at parent gitlink `29136202437149b477e5d21317d82219fcc011bb`; registered its root `SKILL.md` in the Pipi package; generalized installer preflight across configured submodules; and documented the canonical skill and bundled standard-library Python launcher. Initial canonical review found that installer preflight did not enforce the parent pin/clean child and that this operation entry was missing; both blockers were remediated with retained regression coverage. Opened [PR #16](https://github.com/blockedby/my-pi-setup/pull/16) to `main`, ran the Pipi installer from the feature worktree, and narrowed that temporary local package entry to only `vendor/plan-gh-backlog/SKILL.md` so existing Pipi resources remain sourced from the primary checkout without duplicate skill names.
- **Affected paths or values:** `.gitmodules`, `vendor/plan-gh-backlog`, `config/submodules.json`, `package.json`, `scripts/install.mjs`, `tests/scripts/install.test.mjs`, `AGENTS.md`, `README.md`, `SETUP.md`, and this record. The backlog source is read-only and pinned to `2913620`; runtime version, MCP version, model overrides, credentials, auth isolation, profiles, and quotas are unchanged.
- **Verification:** Submodule validation accepted both exact clean gitlinks. The final deterministic suite passed 29 script/installer tests, 144 extension tests, and 22 file-search tests; TypeScript, formatting, and `git diff --check` passed. The pinned child passed 13 Python unit tests; Pi's skill loader discovered exactly one `plan-gh-backlog` skill; and the bundled CLI validated and planned its complete example. Canonical closure review marked `REV-001` and `REV-002` fixed and returned `READY` with no new findings. Target preparation reported an up-to-date, conflict-free branch with no rerun required. Pipi package resolution confirmed the worktree contributes exactly the one intended skill and no extension, prompt, theme, or other skill; `pipi list` shows the filtered package, `pipi --version` remains `0.84.2`, and the bundled CLI reports `plan-gh-backlog 1.0.0`.
- **Pending:** Reload or restart the active Pipi session to discover the newly installed skill. PR #16 is open to `main`; merge remains a separate decision. After merge, rerun the primary-checkout installer and remove the temporary filtered worktree package entry before worktree cleanup.
