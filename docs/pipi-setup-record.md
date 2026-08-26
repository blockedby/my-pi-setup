# Pipi setup record

This is the durable, user-facing record for the local `pipi` setup. Append future Pipi requests here after they are implemented or clearly identified as pending. Never record tokens, API keys, OAuth credentials, cookies, or auth-file contents.

## Current installation

| Item                                    | Location / value                                         |
| --------------------------------------- | -------------------------------------------------------- |
| Source checkout                         | `/home/kcnc/code/tools/pipi-alias`                       |
| Source branch                           | `main`                                                   |
| Launcher                                | `/home/kcnc/.local/bin/pipi`                             |
| Pipi Pi executable                      | `/home/kcnc/.pipi/agent/npm/node_modules/.bin/pi`        |
| Pipi runtime package                    | `@earendil-works/pi-coding-agent@0.84.3`                 |
| Pipi settings                           | `/home/kcnc/.pipi/agent/settings.json`                   |
| Pipi model overrides                    | `/home/kcnc/.pipi/agent/models.json`                     |
| Tracked model-override record           | `config/pipi-model-overrides.json`                       |
| Pipi sessions                           | `/home/kcnc/.pipi/sessions`                              |
| Creator setup package                   | `/home/kcnc/code/tools/pipi-alias`                       |
| Codex tools package                     | `/home/kcnc/code/tools/pi-codex`                         |
| MCP adapter                             | `npm:pi-mcp-adapter@2.15.0`                              |
| Isolated MCP package files              | `/home/kcnc/.pipi/agent/npm/node_modules/pi-mcp-adapter` |
| Browser Chrome skill                    | `/home/kcnc/.pipi/agent/skills/browser-chrome`           |
| Evidence-driven reviewer submodule      | `vendor/gpt5.6-reviewer` at `5c446e5`                    |
| Canonical code-review skill             | `vendor/gpt5.6-reviewer/skills/code-review`              |
| Backlog planning submodule              | `vendor/plan-gh-backlog` at `5a179fb`                    |
| Canonical plan-gh-backlog skill         | `vendor/plan-gh-backlog`                                 |
| Browser MCP config                      | `/home/kcnc/.pipi/agent/mcp.json`                        |
| Theme                                   | `github-dark-default`                                    |
| Current Pipi Pi version                 | `0.84.3`                                                 |
| Original Pipi Pi version                | `0.82.1`                                                 |
| Codex CLI version at initial acceptance | `0.145.0`                                                |

## Isolation contract

- `pipi` launches the exact pinned runtime at `/home/kcnc/.pipi/agent/npm/node_modules/.bin/pi` (`@earendil-works/pi-coding-agent@0.84.3`); it is not a second global installation and does not replace or launch regular `pi` by default.
- The installer brands that isolated runtime as `pipi`, so Pi's own banner, terminal title, help, and resume command use the Pipi name.
- The launcher exports `PIPI_CODING_AGENT_DIR=/home/kcnc/.pipi/agent` and the compatibility alias `PI_CODING_AGENT_DIR`.
- The launcher exports `PIPI_CODING_AGENT_SESSION_DIR=/home/kcnc/.pipi/sessions` and the compatibility alias `PI_CODING_AGENT_SESSION_DIR`.
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

## Operation entry: default GitHub CLI timeout guidance

- **Request:** Add only one sentence to the canonical `git-branching` skill making 15 seconds the default timeout for direct `gh` operations, push it straight to the source repository's `main`, and refresh the locally installed Pipi skill.
- **Action:** Added `Use a 15-second wall-clock timeout for direct gh operations by default.` to `/home/kcnc/code/tools/pi-agent-setup/skills/general/git-branching/SKILL.md`, committed it as `ca039fb` (`docs(git): set default gh timeout`), and pushed `blockedby/pi-agent-setup` `main`. Reinstalled the ownership-managed `general` skill set into `/home/kcnc/.pipi/agent`, updating the local `git-branching` copy without changing unrelated skill ownership.
- **Affected paths or values:** Canonical source `skills/general/git-branching/SKILL.md` in `pi-agent-setup`, installed `/home/kcnc/.pipi/agent/skills/git-branching/SKILL.md`, and this record. The unrelated untracked source-repository `.claude/` directory was preserved and not staged.
- **Verification:** Source `git diff --check`, direct local-asset tests, and the direct secret check passed; source and installed `SKILL.md` copies compare byte-for-byte and both contain the 15-second sentence. The npm wrappers could not start because the source repository requires Node 24.18.0 while the host has 24.19.0, so their underlying relevant scripts were run directly instead.
- **Pending:** Reload or restart the active Pipi session so its loaded skill context reflects the updated installed file.

## Operation entry: relaxed pi-agent-setup Node development range

- **Request:** Replace the exact Node 24.18.0 development-runtime requirement with a less strict rule.
- **Action:** Changed `pi-agent-setup` `package.json` `devEngines.runtime.version` from `24.18.0` to `^24.18.0`, committed it as `ae96283` (`build: relax Node development runtime range`), and pushed directly to `blockedby/pi-agent-setup` `main` as requested. This accepts compatible Node 24 releases, including the current 24.19.0 host, while remaining within major version 24.
- **Affected paths or values:** `/home/kcnc/code/tools/pi-agent-setup/package.json` and this record. The unrelated untracked source-repository `.claude/` directory remained untouched.
- **Verification:** With Node 24.19.0, the full `npm test` chain now starts and passes: config components, local assets, runtime resolution, AAD task package, OpenCode adapter, and main-thread wait guard. `npm run secrets:check` and `git diff --check` also passed.
- **Pending:** None.

## Operation entry: Luna delegation ownership guidance

- **Request:** Turn a one-off agent message into durable agent-level guidance that decomposes feature work into short parallel Luna tasks, gives every Luna one bounded deliverable and explicit file ownership/non-goals, separates schemas, validators, fixtures/tests, and documentation when independently verifiable, includes compact desired-module pseudocode for implementation tasks, leaves shared integration/conflicts with the main agent, uses up to eight dependency-ready workers, and opens a pull request.
- **Action:** Added three always-loaded parent-agent guidelines to `subagent_spawn`: scope and edit-ownership decomposition, compact module-contract pseudocode with a feature example, and same-wave fanout for non-overlapping work. Removed the shorter duplicated integration clause from the profile-selection guideline. Did not change child profile prompts, schemas, validators, quotas, runtime admission, or conditional skill text.
- **Affected paths or values:** `extensions/subagents/src/prompt.ts`, `extensions/subagents/spawn-contract.test.ts`, `extensions/subagents/policy.test.ts`, and this record. Direct quotas remain Sol=4, Terra=8, Luna=16; the workflow cap and soft Luna fanout recommendation remain eight.
- **Verification:** At the user's request, removed the new prompt-word matching test and the two pre-existing subagent tests/assertions that matched literal words in parent or child prompt strings. Structural profile/schema/runtime tests remain. Search confirmed no parent/child prompt-word matching test remains under `extensions/subagents`. Fresh checks passed 29 script/installer/submodule tests, 143 deterministic extension tests, and 22 file-search tests; the focused policy/schema suite passed 6/6, and TypeScript, formatting, submodule validation, and `git diff --check` passed.
- **Review:** The original guidance review returned `READY`. Refreshed canonical review after removing prompt-word assertions also returned `READY` with no findings and confirmed structural schema/profile/append, runtime, and quota coverage remains.
- **Pull request:** Committed the guidance as `a812c67`, opened [PR #18](https://github.com/blockedby/my-pi-setup/pull/18), and committed the requested test cleanup as `8ba7970` (`test(subagents): remove prompt wording assertions`).
- **Preparation:** Final preparation rebased onto the newer `origin/main` and found one conflict only in this operation record because the main branch gained the GitHub-timeout and Node-range entries. Preserved both main-branch entries and this PR's complete record; no product or test file conflicted. Post-rebase checks again passed 29 script/installer/submodule tests, 143 deterministic extension tests, 22 file-search tests, the focused 6/6 suite, TypeScript, formatting, Pipi version/install checks, submodule validation, and `git diff --check`.
- **Pending:** Commit the conflict-resolution record, rerun required post-fixup verification, force-push the rebased PR #18 branch with lease, merge as authorized, synchronize `main`, and clean up the local feature worktree/branch.

## Operation entry: merged Luna delegation guidance

- **Request:** Merge the open pull request for this repository.
- **Action:** Prepared PR #18 against the newer `origin/main`, resolved its sole operation-record conflict while preserving both histories, reran required verification, force-pushed with lease, and squash-merged [PR #18](https://github.com/blockedby/my-pi-setup/pull/18) as `8e5f7eb`. Synchronized local `main`, deinitialized submodules in the feature worktree after the cleanup helper encountered Git's worktree/submodule removal restriction, then removed the worktree and local feature branch. The remote feature branch was retained.
- **Affected paths or values:** Merged `extensions/subagents/src/prompt.ts`, the removal of literal prompt-word assertions from `extensions/subagents/policy.test.ts`, and the operation record. Runtime quotas, child profiles, tool schemas, workflow limits, installed dependencies, model overrides, and credentials are unchanged.
- **Verification:** Canonical reviews returned `READY` before and after the requested test cleanup. Final post-rebase checks passed 29 script/installer/submodule tests, 143 deterministic extension tests, 22 file-search tests, TypeScript, formatting, Pipi version/install validation, submodule validation, and `git diff --check`. GitHub reports PR #18 merged; local `HEAD` equals `origin/main`; the feature worktree and local branch are absent.
- **Pending:** Reload or restart the active Pipi session so it loads the merged parent-agent guidance.

## Operation entry: clarify code-review skill trigger

- **Request:** Replace the upstream `code-review` skill header description with correct English expressing that initial or closure reviews require deep analysis and a structured response.
- **Action:** Replaced the description with `Use when an initial or closure code review requires deep analysis and a structured response.` in the canonical `gpt5.6-reviewer` repository, amended the change on `docs/clarify-code-review-skill-description` as `d27ae6c`, force-pushed with lease, and refreshed [upstream PR #2](https://github.com/blockedby/gpt5.6-reviewer/pull/2) to `main`. Target preparation reported the branch current and conflict-free.
- **Affected paths or values:** Upstream `skills/code-review/SKILL.md` frontmatter only. The read-only `vendor/gpt5.6-reviewer` submodule and its parent gitlink remain unchanged pending the upstream merge; installed skills and credentials are unchanged.
- **Verification:** All 51 upstream Python unit tests passed, the exact frontmatter structure was asserted, and `git diff --check` passed.
- **Pending:** Merge upstream PR #2 if approved, update this repository's `vendor/gpt5.6-reviewer` gitlink to the merged upstream commit through a parent-repository PR, run required submodule/installer/type/format checks, and reload Pipi after that parent PR merges and installs.

## Operation entry: merge and pin revised code-review description

- **Request:** Merge the approved upstream description change and update Pipi to use it.
- **Action:** Squash-merged upstream `gpt5.6-reviewer` PR #2 as `5c446e5`, synchronized its canonical local `main`, and removed the upstream feature worktree and local branch. Created parent branch `chore/update-gpt5.6-reviewer-description` and advanced the read-only `vendor/gpt5.6-reviewer` gitlink from `81053d6` to the reviewed upstream merge commit `5c446e5`; `.gitmodules` and `config/submodules.json` already match the unchanged upstream URL and `main` branch.
- **Affected paths or values:** Parent gitlink `vendor/gpt5.6-reviewer` and this operation record. The submodule changes only `skills/code-review/SKILL.md` frontmatter to `Use when an initial or closure code review requires deep analysis and a structured response.` No credentials, model overrides, dependencies, or unrelated submodule pins changed.
- **Verification:** GitHub reports upstream PR #2 merged, the canonical upstream checkout equals `origin/main`, and all 51 upstream Python tests pass. After installing each worktree dependency set, parent checks passed 29 script/installer/submodule tests, 143 deterministic extension tests, 22 file-search tests, TypeScript, formatting, exact submodule validation, Pipi version/install validation, and `git diff --check`. The first parent test attempt lacked worktree-local extension dependencies and failed only with package-resolution errors; no code defect was indicated, and the complete rerun passed after `npm run install:dependencies`.
- **Pull request and preparation:** Committed the parent update as `f6c59a2` (`chore: update code review skill pin`), pushed the branch, and opened [parent PR #19](https://github.com/blockedby/my-pi-setup/pull/19). Target preparation reported it current and conflict-free with no verification rerun required.
- **Pending:** Commit this final PR record, push the branch, merge PR #19 as authorized, synchronize `main`, reinstall the canonical skill, verify source/installed parity, and clean up the feature worktree and branch.

## Operation entry: completed reviewer description rollout

- **Request:** Merge the revised upstream reviewer description and update Pipi to use it.
- **Action:** Merged upstream `gpt5.6-reviewer` PR #2 as `5c446e5`, advanced the parent gitlink through [PR #19](https://github.com/blockedby/my-pi-setup/pull/19), and squash-merged that PR as `58d6338`. Synchronized parent `main`, deinitialized the feature worktree's submodules to satisfy Git's cleanup restriction, removed its worktree and local branch, updated the primary checkout's submodules, and reran `npm run install:pipi` so the active Pipi package resolves the new canonical skill.
- **Affected paths or values:** `vendor/gpt5.6-reviewer` now pins `5c446e5`; its `code-review` description is `Use when an initial or closure code review requires deep analysis and a structured response.` The operation record changed; credentials, model overrides, dependencies, and `vendor/plan-gh-backlog` remain unchanged. The upstream and parent remote feature branches were retained.
- **Verification:** Upstream tests passed 51/51. Parent validation passed 29 script/installer/submodule tests, 143 deterministic extension tests, 22 file-search tests, TypeScript, formatting, Pipi version/install checks, exact submodule validation, and `git diff --check`. GitHub reports both PRs merged; upstream and parent local `main` checkouts equal their `origin/main`; `pipi list` resolves the filtered canonical parent package; the source frontmatter contains the exact revised description; and no duplicate host `code-review` skill exists.
- **Pending:** Reload or restart the active Pipi session so its already-loaded skill catalog picks up the revised description.

## Operation entry: revert PR #20 workflow and delegation changes

- **Request:** Return the project to its state before merged PR #20; do not preserve the raw workflow feature or start the planned pipeline replacement.
- **Action:** Reverted squash merge `754d82b` from PR #20 on a dedicated revert branch. This removes the speed-first Luna delegation guidance, the `/solve-issue` prompt template and its registration/test, raw workflow guidance changes, README entry, and the prompt-test policy that were introduced by that PR. The exploratory pipeline branch and unfinished registry analysis were discarded/cancelled.
- **Affected paths or values:** Restored the pre-PR #20 behavior across `extensions/subagents`, `extensions/workflows`, `prompts/`, `package.json`, `README.md`, `AGENTS.md`, and this record. Runtime configuration, credentials, model overrides, dependency versions, and submodule pins remain unchanged.
- **Verification:** `git revert` applied cleanly. After running `npm run install:dependencies` in the fresh worktree, passed `npm run check`, `npm run test:extensions` (143 deterministic tests), `npm run format:check`, and `git diff --check`.
- **Review and merge:** Independent Terra review returned `READY` with no findings and confirmed the non-log tree equals pre-PR #20 parent `a1615b8`. Squash-merged [PR #21](https://github.com/blockedby/my-pi-setup/pull/21) as `bddf8af637654a5c4d39270b8d1a9b4dde193211`; primary `main` then fast-forwarded to that commit.
- **Pending:** None.

## Operation entry: collaborative pipelines v1 design

- **Request:** Plan a replacement for the reverted raw-workflow proposal collaboratively before implementation. v1 should contain one hardcoded pipeline graph, have main-agent activation analogous to subagents, and provide a nested pipeline UI.
- **Action:** Created `docs/pipelines-v1-design.md` as the durable working-design record. v1 is scoped to one hardcoded feature-pipeline; later versions may add task-specific graphs. One persistent Sol pipeline agent owns orchestration, planning, implementation, and remediation using run-scoped child-management tools. It launches five parallel Luna discovery tracks (Problem, Outcome with candidate AC, Context, User Scenarios, Product Precedents), then plans and implements; launches four parallel Luna feature-audit tracks, resolves them; launches one independent Terra final audit, then resolves it with no re-audit loop. Failed Discover/Audit tracks may be retried once. Child reports return naturally into the same pipeline-agent context, and nested children are recorded under the pipeline run. The pipeline hands the branch and reports to the main agent for its decision. Git/worktree policy is not embedded in the graph: the main agent prepares and passes the workspace and delivery constraints according to project guidance; commonly that is a dedicated branch/worktree with commits, but other environments may differ.
- **Affected paths or values:** Added `docs/pipelines-v1-design.md` and this record only. The design now requires reusable shared agent-tree infrastructure (hierarchical state, subscriptions, transcripts, steer/cancel, and takeover UI) so `/pipelines` can fully control its nested agents and a later PR can add a second subagent level without duplicating the core. Pipeline children remain outside `/subagents` in v1. No runtime behavior, installed resources, model overrides, credentials, dependency versions, or submodules changed.
- **Verification:** New-document content was reviewed in the dedicated feature worktree; implementation checks are not applicable until the collaboratively designed graph is implemented.
- **Pending:** Implement the approved runtime/TUI architecture, collaboratively refine detailed prompts and structured report schemas, then run full checks and independent review.

## Operation entry: feature-pipeline v1 vertical slice

- **Request:** Implement the approved feature-pipeline v1 vertical slice with a fire-and-forget `pipeline_run` tool, persistent Sol root, fixed Luna/Terra children, nested `/pipelines` takeover UI, reusable shared agent-tree infrastructure, factual completion handoff, session-scoped cleanup, and deterministic contract coverage; do not commit, push, open a PR, or run live model backends.
- **Action:** Added `extensions/pipelines` with the hardcoded graph prompts, controller, Pi SDK session adapter, run-scoped tools, bounded completion follow-up, and nested dashboard. The public tool accepts a self-contained task and optional working directory. A persistent Sol/high pipeline agent manages five Luna/medium discovery roles, implementation, four Luna/medium feature-audit roles, an independent Terra/high final audit, remediation, and a factual handoff without a readiness label. Added same-session child retry/continuation, explicit assumptions, combined Build and separate audit/final-resolution stages, and active-child completion protection. Added reusable in-memory hierarchy, transcript folding, subscriptions, steering/cancellation, and generic takeover UI under `extensions/shared/agent-tree`. Extended shared headless-session policies so pipeline roots retain only run-scoped orchestration and pipeline children cannot access pipeline, workflow, direct-subagent, or user-prompt orchestration; ordinary Pi subagents now consume that same shared denylist so the new pipeline tool does not create an orchestration recursion path. Raw workflow APIs and the `/subagents` projection were not changed. Updated README discovery documentation.
- **Affected paths or values:** `extensions/pipelines/**`, `extensions/shared/agent-tree/**`, `extensions/shared/agent-tree.test.ts`, `extensions/shared/child-session.ts`, `extensions/shared/child-session.test.ts`, `extensions/subagents/src/backends/pi.ts`, `README.md`, `docs/pipelines-v1-design.md`, and this record. Model overrides, credentials, dependency versions, raw workflow behavior, and direct-subagent hierarchy remain unchanged.
- **Verification:** Ran `npm run install:dependencies`; focused pipeline/shared tests passed 23/23; `npm run test:extensions` passed 161/161 deterministic tests; `npm run check`, `npm run format:check`, `npm run test:installer` (29/29), and `git diff --check` passed. No live model backend was run.
- **Review:** Canonical initial review returned `NOT_READY` with `REV-001` (pipeline capacity did not share direct-subagent admission) and `REV-002` (`x` on an idle root did not cancel the active run). The user explicitly accepted independent pipeline capacity as intended product behavior, so the design now records pipeline-local Sol=4, Terra=8, and Luna=16 pools rather than a shared quota requirement. First closure review marked `REV-001` not applicable and `REV-002` fixed, then found `REV-003`: cancelling a `starting` run could emit its handoff before asynchronous root creation completed, allowing the late root session to prompt. The second remediation adds a post-creation/pre-prompt start predicate; a cancelled run disposes the late session without prompting, links the cancelled root snapshot, and emits no duplicate handoff. Gated deterministic coverage reproduces the run-row cancellation timing.
- **Closure:** Canonical closure review of remediation `982414a` returned `READY` with no residual findings and marked `REV-003` fixed. Fresh closure evidence included the gated regression plus 163/163 extension tests, TypeScript, formatting, and `git diff --check`.
- **Pull request:** Prepared the branch against `origin/main` with no rebase/content change required, pushed `feat/pipelines-v1`, and opened [PR #23](https://github.com/blockedby/my-pi-setup/pull/23).
- **Pending:** Review PR #23. The subsequently authorized live runtime acceptance is recorded below.

## Operation entry: live feature-pipeline acceptance smoke

- **Request:** Run and verify the new pipeline with real Sol, Luna, and Terra sessions.
- **Action:** Started the feature pipeline through its real `pipeline_run` extension in a disposable Git repository at `/tmp/pipi-feature-pipeline-live-ZeW84D`. The self-contained task added `renameTask(id, newTitle)` to a minimal in-memory task store. The run used one persistent Sol/high root, five Luna/medium Discover children, four Luna/medium feature-audit children, and one Terra/high final-audit child. The temporary SDK runner was removed after completion; no Pipi configuration, credentials, model overrides, production workspace, commits, pushes, or remote repository state were changed by the pipeline.
- **Affected paths or values:** Only the disposable fixture changed: `README.md`, `src/task-store.js`, and `test/task-store.test.js`. Diagnostic evidence remains in `/tmp/pipi-feature-pipeline-live.jsonl` and twelve fixture-scoped session files under `~/.pipi/agent/sessions/--tmp-pipi-feature-pipeline-live-ZeW84D--/`. Repository product code was unchanged by the smoke; this operation record and PR #23 verification metadata are the only durable project updates.
- **Verification:** The live run completed in 3m23s with a factual handoff. Root transcript evidence shows ten child spawns in the approved role order, three fan-in waits, all seven stage transitions (`discover`, `build`, `audit`, `audit-resolve`, `final-audit`, `final-resolve`, `complete`), and one completion call. All five Discover reports matched the shared `summary/evidence/unknowns/constraints` JSON contract; all four Luna audit reports matched the `track/findings/unprovenChecks` contract; Terra returned canonical review JSON and its transcript records an actual read of `code-review/SKILL.md`. The independent Terra context contained the feature contract, assumptions, and fresh checks but no Luna report IDs/content. Post-run verification independently passed `npm test` (4/4), `git diff --check`, expected-path status, and diff inspection; the fixture remained on its baseline commit with no push.
- **Pending:** Review PR #23; remove the disposable fixture/log/session artifacts when no longer needed.

## Operation entry: install feature-pipeline branch for interactive trial

- **Request:** Install the feature-pipeline implementation into Pipi so it can be tried interactively.
- **Action:** Ran `npm run install:pipi` from `/home/kcnc/code/tools/pipi-alias/.worktrees/pipelines-v1`, which installed dependencies, refreshed the managed Pipi launcher/settings wiring, and added the feature worktree as a package. The first installed-resource probe exposed duplicate tool registrations because the primary checkout package remained enabled alongside the feature worktree. Removed only `/home/kcnc/code/tools/pipi-alias` from the Pipi package list; the feature worktree now supplies the complete setup, while `pi-codex`, `pi-mcp-adapter`, and the filtered plan-backlog worktree remain enabled. No authentication data was read or changed.
- **Affected paths or values:** `~/.pipi/agent/settings.json` now references the feature worktree instead of the primary checkout for this package; `/home/kcnc/.local/bin/pipi` remains the managed launcher; dependencies under the feature worktree were refreshed. Pipi remains at 0.84.2 with MCP 2.15.0 and unchanged model overrides/credentials.
- **Verification:** `npm run check:pipi-install` passed after the package-list correction. `pipi list` shows the feature worktree and no primary-checkout duplicate. A fresh SDK/resource-loader probe using the installed settings returned `pipelineRunActive: true`, `pipelineExtensionLoaded: true`, and `extensionErrors: []`. Temporary probe files were removed and the feature worktree remained clean.
- **Pending:** Reload or restart the current Pipi session before trying `pipeline_run` or `/pipelines`; review PR #23.

## Operation entry: add planning-only plan-pipeline

- **Request:** Add a second first-class hardcoded `plan-pipeline` that inspects a repository, writes and audits a durable Markdown implementation plan, remediates Luna and Terra findings once, preserves `feature-pipeline` compatibility, and leaves changes uninstalled and uncommitted for inspection.
- **Action:** Extended the bounded `pipeline_run` selector to the known `feature-pipeline` and `plan-pipeline` definitions, with omission still defaulting to `feature-pipeline` and unknown values rejected. Added the fixed planning graph with one persistent Sol/high root, five direct Luna/medium discovery concerns, four direct Luna/medium plan-audit concerns, and one independent Terra/high final audit using canonical review routing adapted to plan quality. The controller enforces plan-stage order, required valid reports, bounded Luna retry and no Terra retry. Plan roots/children are denied shell/edit/write, delegated mutation, and background-shell tools; Sol writes only through a bounded repository-local `docs/plans/*.md` tool and receives bounded artifact-validation and Git-status tools. Added substantive plan/task/dependency/wave validation, report-contract diagnostics, factual plan-path handoff data, and two-definition `/pipelines` hierarchy while retaining shared transcript, steering, cancellation, capacity, and session-scoped lifecycle infrastructure. Updated README and the pipelines design record. No planned product feature was implemented, and no runtime install, live nested plan-pipeline, commit, push, credential, model override, dependency, or submodule change was made.
- **Affected paths or values:** `extensions/pipelines/domain.ts`, `controller.ts`, `prompt.ts`, `session.ts`, `index.ts`, `dashboard.ts`, new `plan-contract.ts`, their deterministic tests, `extensions/shared/child-session.ts` and its policy test, `README.md`, `docs/pipelines-v1-design.md`, and this operation record. `extensions/shared/agent-tree/**`, installed Pipi state, `config/pipi-model-overrides.json`, authentication data, and vendored submodule pins remain unchanged.
- **Verification:** Focused pipeline and child-policy tests passed 34/34; after final remediation, the full deterministic extension suite passed 174/174 and installer tests passed 29/29; `npm run check:submodules`, TypeScript, formatting, and `git diff --check` passed. No live model backend or nested plan-pipeline was run.
- **Review and remediation:** Four Luna tracks identified planning-only mutation boundaries, graph/retry cardinality, semantic plan validation, and dependency-safe-wave enforcement; the controller, session policies, bounded tools, validator, and tests were strengthened accordingly. The independent Terra audit then identified canonical final-report validation (`REV-001`) and final-artifact provenance/symlink safety (`REV-002`); remediation now validates the complete canonical initial-review shape and binds completion to the non-symlink artifact digest/device/inode written by that run, with rejecting regression coverage. Per the fixed graph, no re-audit was run after Terra remediation. Main-agent acceptance subsequently found and fixed three residual contract boundaries without starting another audit: parent-directory symlinks are rejected before directory creation can mutate outside the workspace; Discovery and Luna audit reports now require their complete exact structured schemas instead of only top-level container types; and the generic `mcp` gateway is denied to planning roots/children because it can expose externally mutating tools. Added direct regressions for each boundary.
- **Main-agent verification:** Focused pipeline/policy tests passed 35/35 after acceptance remediation. Fresh worktree-local final checks passed 175/175 deterministic extension tests, 29/29 installer/submodule tests, exact submodule validation, TypeScript, formatting, and `git diff --check`.
- **Pending:** Commit and push the accepted change to PR #23, then run one authorized disposable live `plan-pipeline` acceptance before interactive use.

## Operation entry: investigate pipeline dashboard stage-status mismatch

- **Request:** Investigate why `/pipelines` keeps the orange running square on the persistent Sol root instead of the active `build` stage, and why `audit-resolve` remains pending after all audit children have completed; discuss the safest fix before implementation.
- **Action:** Inspected the two supplied screenshots and traced dashboard row construction/rendering against the controller stage contract. Identified two separate presentation causes: status glyphs are rendered only for agent rows, so the persistent root owns the orange square for the whole run; and stage rows display only the last explicit `pipeline_stage` value, leaving the dashboard one phase behind during Sol's post-fan-in reasoning interval after `pipeline_child_wait` returns. No runtime, dashboard, controller, tests, installed Pipi state, credentials, model overrides, dependencies, or submodules were changed.
- **Affected paths or values:** Read-only investigation of `extensions/pipelines/dashboard.ts`, `dashboard.test.ts`, `controller.ts`, `domain.ts`, `prompt.ts`, `plan-contract.ts`, the pipeline design record, Pi TUI documentation, and the supplied screenshots. This operation record is the only changed path for this investigation.
- **Verification:** Confirmed in source that `statusGlyph` is applied only when `row.kind === "agent"`, while stage labels are calculated directly from `PIPELINE_STAGES.indexOf(run.stage)` and use `current`/`pending`; confirmed the fixed graph defines `audit-resolve` as the work immediately after successful audit fan-in.
- **Pending:** Superseded by the approved implementation below, which updates authoritative `run.stage` at successful fan-in rather than projecting a dashboard-only stage.

## Operation entry: align authoritative pipeline stage and dashboard activity

- **Request:** Implement the pipeline dashboard status correction directly, without agents or pipelines, and prefer changing authoritative `run.stage` because post-audit resolution is genuinely a different stage.
- **Action:** Made `pipeline_child_wait` an atomic fan-in boundary: after a wait returns, the controller advances `discover → build`, `audit → audit-resolve`, or `final-audit → final-resolve` only when the wait involved the current stage and every required role has a successful report accepted by that definition's validator. Missing, failed, or cancelled required reports—and contract-invalid reports where the definition enforces that contract—leave the stage unchanged for retry. Updated both pipeline prompts and the runtime design contract to describe the automatic transition. Dashboard stage labels now use `running` instead of `current`; the orange running glyph is rendered on the authoritative active stage, not the persistent Sol root, while child attempt result glyphs remain.
- **Affected paths or values:** `extensions/pipelines/controller.ts`, `controller.test.ts`, `dashboard.ts`, `dashboard.test.ts`, `prompt.ts`, `docs/pipelines-v1-design.md`, and this operation record. No agents, pipelines, live model backends, credentials, model overrides, dependencies, submodules, commits, pushes, or installed settings were invoked or changed by this operation.
- **Verification:** Added regressions proving Discover fan-in updates actual stage to `build`, Audit fan-in updates actual stage and dashboard label to `audit-resolve · running`, final-audit fan-in updates actual stage to `final-resolve`, invalid required plan reports do not advance, and the glyph belongs to the active stage rather than the root. Focused pipeline tests passed 22/22; the full deterministic extension suite passed 178/178; TypeScript, formatting, submodule validation, and `git diff --check` passed.
- **Pending:** Reload or restart the currently running Pipi session, then run a fresh interactive pipeline to visually confirm the updated `/pipelines` rendering. The source worktree is already the configured Pipi package; no reinstall is required.

## Operation entry: live plan-pipeline acceptance smoke

- **Request:** Exercise the newly added `plan-pipeline` on a goal that requires frontend, backend, DevOps, and test-plan decomposition.
- **Action:** Ran the installed public `pipeline_run` selector with `plan-pipeline` against the disposable full-stack Git fixture `/tmp/pipi-plan-pipeline-live-axQg2E`. One persistent Sol/high root coordinated five Luna/medium discovery roles, wrote and remediated only `docs/plans/user-initiated-account-deletion.md`, coordinated four Luna/medium plan-audit roles, and received one independent Terra/high final audit. No product code, commit, push, runtime installation, credential, model override, or external deployment state changed. The temporary SDK runner was removed after completion.
- **Affected paths or values:** The disposable fixture gained only `docs/plans/user-initiated-account-deletion.md` (37,435 bytes, 322 lines). Diagnostic evidence remains in `/tmp/pipi-plan-pipeline-live.jsonl` and twelve fixture-scoped session files under `~/.pipi/agent/sessions/--tmp-pipi-plan-pipeline-live-axQg2E--/`. Repository source was not changed by the live run; this record and PR #23 verification metadata are the only durable project updates from the smoke.
- **Verification:** The real run completed in 19m43s with twelve sessions and the selected definition reported as `plan-pipeline`. Root transcript evidence shows ten fixed child spawns in the approved order, three waits, all seven stage transitions, five bounded plan writes, three fresh plan validations, four bounded Git-status reads, and one completion; no session called `bash`, `edit`, `write`, `mcp`, delegated mutators, or background-process mutators. All ten child reports were valid JSON; Terra read the canonical code-review skill and its supplied context contained no Luna reports. Independent post-run validation returned no artifact issues, 22 unique stable tasks, all eleven required sections, dependency-safe waves, and complete unit/integration/contract/e2e/operational coverage. Git remained on the fixture baseline with only the untracked `docs/` artifact and no tracked diff.
- **Pending:** Review PR #23; remove the disposable fixture/log/session artifacts when no longer needed. Reload/restart Pipi before interactive use of the newly loaded selector and UI.

## Operation entry: explain plan-pipeline behavior

- **Request:** Explain the newly implemented planning pipeline.
- **Action:** Described the bounded selector, fixed Sol/Luna/Terra graph, planning-only enforcement, validated Markdown artifact contract, audit/remediation flow, factual handoff, dashboard controls, operational cost, and limitations. No pipeline, model backend, runtime installation, configuration change, commit, push, or external action was performed for this explanation.
- **Affected paths or values:** This operation record only; product/runtime behavior, credentials, model overrides, dependencies, and submodules are unchanged.
- **Verification:** Explanation was grounded in the implemented controller/session/tool contracts and the completed 12-session live acceptance that produced a valid 22-task frontend/backend/DevOps/test plan without product-code mutation.
- **Pending:** Reload/restart Pipi before interactive use; review PR #23.

## Operation entry: clarify automatic plan-pipeline routing

- **Request:** Clarify whether the main agent understands when the planning pipeline is appropriate and what criteria trigger it.
- **Action:** Explained the implemented model-facing routing guidance and distinguished semantic main-agent selection from host-enforced contracts. The current hard semantic signal is an explicit `plan-pipeline` request or a requested durable audited implementation plan; nontriviality/cross-layer scope is a model judgment rather than a host-side classifier. Bugs, refactors, research-only work, trivial edits, and direct implementation outcomes are intentionally routed elsewhere. No prompt, runtime, tool schema, pipeline, model backend, configuration, commit, push, or external state was changed.
- **Affected paths or values:** This operation record only; product/runtime behavior, credentials, model overrides, dependencies, and submodules are unchanged.
- **Verification:** Compared the explanation with the implemented `pipeline_run` description/guidelines and bounded selector contract in `extensions/pipelines/index.ts`.
- **Pending:** Superseded by the approved routing-guidance update recorded below; reload/restart Pipi before interactive use and review PR #23.

## Operation entry: publish pipeline stage-status correction to PR

- **Request:** Open a pull request for the pipeline stage-status correction.
- **Action:** Confirmed that branch `feat/pipelines-v1` already has open PR #23 against `main`, so no duplicate PR was created. Committed the authoritative fan-in stage transitions and dashboard activity-glyph correction as `8035d93` (`fix(pipelines): align active stage status`), confirmed the branch was already up to date with `origin/main`, pushed it to `origin/feat/pipelines-v1`, and updated PR #23's summary and verification evidence.
- **Affected paths or values:** Git branch `feat/pipelines-v1`, commit `8035d93`, remote branch `origin/feat/pipelines-v1`, and <https://github.com/blockedby/my-pi-setup/pull/23>. No merge, deployment, runtime installation, credential, model override, dependency, or submodule change was performed.
- **Verification:** Pre-publish evidence remained 178/178 deterministic extension tests, 22/22 focused pipeline tests, TypeScript, formatting, submodule validation, and `git diff --check`. The target-branch preparation helper reported `rebase_status=up_to_date`, `content_changed=false`, and `rerun_required=false`. GitHub confirmed PR #23 is open with base `main`, head `feat/pipelines-v1`, and the updated body; no repository checks are configured.
- **Pending:** Superseded by the merge and local installation refresh recorded below.

## Operation entry: merge pipelines PR and refresh local Pipi installation

- **Request:** Merge PR #23 and update the local Pipi installation if needed.
- **Action:** Squash-merged PR #23 into `main` as `9cf2e50`, fast-forwarded the primary checkout to `origin/main`, ran `npm run install:pipi` from the merged primary checkout, and removed the obsolete `/home/kcnc/code/tools/pipi-alias/.worktrees/pipelines-v1` package entry so the merged primary checkout is the sole Pipi package source for this repository. The dirty feature worktree and its unrelated concurrent operation-log edit were preserved rather than deleted. No authentication data, model override values, dependency pins, or submodule pins were changed.
- **Affected paths or values:** GitHub PR #23, local/remote `main` at `9cf2e50`, dependencies refreshed under the primary checkout, managed launcher `/home/kcnc/.local/bin/pipi`, Pipi settings under `~/.pipi/agent/settings.json`, and this operation record. Installed Pipi remains 0.84.2 with MCP 2.15.0.
- **Verification:** GitHub reports PR #23 merged. The target sync helper reported `sync_status=fast_forwarded` with no stash. `pipi list` now contains `/home/kcnc/code/tools/pipi-alias` and no pipelines feature-worktree duplicate. `npm run check:pipi-install` passed; `pipi --version` returned 0.84.2; the isolated runtime has no unreviewed install scripts. Fresh post-merge pipeline tests passed 22/22, followed by TypeScript and formatting checks.
- **Pending:** Reload or restart the currently running Pipi session before visually confirming the merged dashboard behavior. Feature-worktree cleanup remains deferred because it contains an unrelated uncommitted operation-log entry.

## Operation entry: strengthen automatic pipeline routing criteria

- **Request:** Make the plan-pipeline launch criteria explicit for the main agent.
- **Action:** Revised the `pipeline_run` model-facing guidance with selection precedence and observable routing signals. Explicit pipeline requests are honored. Automatic `plan-pipeline` routing now requires a planning deliverable plus at least one complexity signal: two or more frontend/backend/data/DevOps/runtime layers; migration, rollout, rollback, operational-readiness, or cross-team sequencing; or acceptance criteria, scope, and dependencies requiring repository discovery. Cross-layer implementation requests remain `feature-pipeline`; bugs, refactors, research-only work, and trivial edits use neither; ambiguous plan-versus-implementation intent requires clarification. Added the same concise routing contract to README. No host-side semantic classifier or exact prompt-wording test was added.
- **Affected paths or values:** `extensions/pipelines/index.ts`, `README.md`, this operation record, and follow-up branch `feat/pipeline-routing-criteria`. Pipeline schemas, graphs, models, quotas, runtime installation, credentials, model overrides, dependencies, and submodules are unchanged. PR #23 had already merged as `9cf2e50`; while preparing the follow-up, `origin/main` advanced again to the merge/install record `bcc9786`, so the operation histories were combined and the routing change remains isolated above current `main`.
- **Verification:** Before and after the target refresh, focused pipeline tool-contract tests passed 3/3, the full deterministic extension suite passed 178/178, and TypeScript, formatting, and `git diff --check` passed. The branch-preparation conflict was limited to combining the newer merge/install operation record with this entry; README and routing guidance replayed without conflict. No live backend evaluation was needed for this bounded guidance change.
- **Pull request:** Prepared and pushed `feat/pipeline-routing-criteria`, then opened [PR #24](https://github.com/blockedby/my-pi-setup/pull/24) against current `main`.
- **Pending:** Review and merge PR #24, reinstall or synchronize the primary package if needed, then reload/restart Pipi so the main agent receives the revised tool guidance.

## Operation entry: merge routing criteria and upgrade Pipi to 0.84.3

- **Request:** Merge PR #24, update the local isolated Pipi installation, bump Pipi to the latest stable version, commit the version change, then remove the redundant dependency installation from the upgrade scripts.
- **Action:** Squash-merged PR #24 as `639327d`. The primary-main sync preserved a concurrent uncommitted resume-branding investigation through its safety stash; its operation-record conflict was combined without discarding either history, and the restored branding entry remains uncommitted with the stash retained as backup. Created `chore/pipi-0.84.3` from merged `origin/main`, confirmed npm latest is 0.84.3, ran the required patch-upgrade sequence, and updated aligned Pi AI/coding-agent/TUI ranges plus lockfile from 0.84.2 to 0.84.3. The completion rollout installed exact isolated runtime 0.84.3 from this worktree. No authentication data, model override value, MCP pin, or submodule pin changed.
- **Affected paths or values:** `package.json`, `package-lock.json`, this operation record, branch `chore/pipi-0.84.3`, isolated runtime under `~/.pipi/agent/npm`, launcher `/home/kcnc/.local/bin/pipi`, and Pipi package settings now temporarily resolving this upgrade worktree. `config/pipi-model-overrides.json` and its runtime copy remain unchanged.
- **Verification:** `check:pipi-changelog` confirmed 0.84.2→0.84.3 is a patch and skipped minor/major changelog fetching. `complete:pipi-upgrade` passed aligned-version and exact-submodule checks, 29/29 installer tests, 178/178 deterministic extension tests, 22/22 file-search tests, TypeScript, formatting, and `git diff --check`; rollout installed and verified Pipi 0.84.3 with MCP 2.15.0, reviewed install-script policy, and unchanged model overrides. The 202-second duration was dominated by a cold dependency install (the subagents package alone took about two minutes), followed by the full suite and a redundant second dependency pass during rollout; no model backend or pipeline ran.
- **Pending:** Version bump committed as `65a0281`; the optimized rollout was committed separately as `3e7a697` and published with the upgrade in PR #25. Merge/synchronize/install steps remain below.

## Operation entry: remove duplicate upgrade dependency installation

- **Request:** After committing the 0.84.3 bump, remove the redundant second dependency installation from the upgrade scripts.
- **Action:** Added installer flag `--skip-repository-dependencies`, which skips only root/extension dependency installation while still installing or repairing the isolated Pi runtime and MCP adapter. Changed `rollout:pipi-upgrade` to use this narrower flag after `verify:pipi-upgrade` has already installed and tested repository dependencies. Preserved existing `--skip-dependencies` behavior for callers that intentionally skip both repository and isolated-runtime package installation. Updated setup documentation and added an integration regression proving the new mode omits repository installation while creating exact isolated Pi/MCP packages.
- **Affected paths or values:** `package.json`, `scripts/install.mjs`, `tests/scripts/install.test.mjs`, `SETUP.md`, and this operation record. Runtime versions, credentials, model overrides, submodule pins, pipeline behavior, and existing installer flag semantics are unchanged.
- **Verification:** The first optimization probe accidentally ran from the primary checkout, exercised the old script, and temporarily downgraded the isolated runtime to 0.84.2; this was a command-working-directory error, not a product failure. The corrected worktree-local run passed 30/30 installer tests including the new mode, exact submodule validation, TypeScript, formatting, and `git diff --check`. The optimized real rollout emitted no repository dependency-install step, restored and verified runtime 0.84.3 in 2 seconds, and retained MCP 2.15.0 plus unchanged install-script policy/model overrides. Removed the temporary duplicate worktree package registration afterward; `pipi list` again has only the primary checkout for this package and `pipi --version` reports 0.84.3. No live model backend or pipeline ran.
- **Pull request:** Prepared and pushed `chore/pipi-0.84.3`, then opened [PR #25](https://github.com/blockedby/my-pi-setup/pull/25) with the version bump and separate rollout optimization commits.
- **Merge and rollout:** Squash-merged [PR #25](https://github.com/blockedby/my-pi-setup/pull/25) as `6d3c170`, synchronized primary `main`, and ran the optimized rollout from the primary package. It completed in 1 second with no repository dependency pass, kept only the primary checkout package registration, and verified Pipi 0.84.3, MCP 2.15.0, install-script policy, and unchanged model overrides. The two safety stashes created while preserving the concurrent resume-branding investigation remain intact for that operation's owner.
- **Pending:** Reload or restart Pipi sessions created before this rollout.

## Operation entry: brand the Pipi runtime and welcome screen

- **Request:** Change the interactive exit hint from `pi --session-dir ... --session ...` to `pipi --session-dir ... --session ...`, change the welcome-screen PI block logo to PIPI, use Luna agents for research without a pipeline, and deliver the fix through a separate pull request.
- **Action:** Four read-only Luna investigations traced Pi 0.84.3 branding, launcher options, regression strategy, and the custom welcome header. Implemented Pi's supported `piConfig.name` packaging rebrand as an installer-repaired property of the isolated runtime, including `--skip-dependencies` repair; added branded `PIPI_CODING_AGENT_*` launcher variables while retaining legacy `PI_*` aliases. Updated the custom six-line block logo and transient terminal title from PI to PIPI, with a compact `PIPI` fallback for narrow terminals. No normal welcome image asset exists, so no image protocol behavior changed. Updated installation checks and runtime documentation. No pipeline, credential access, model override change, dependency pin change, or submodule pin change occurred.
- **Affected paths or values:** `scripts/install-dependencies.mjs`, `scripts/install.mjs`, `scripts/check-pipi-install.mjs`, `tests/scripts/install.test.mjs`, `extensions/ui-customization/index.ts`, new `index.test.ts`, `SETUP.md`, three explanatory documents, this installation summary, and branch/worktree `fix/pipi-branding` at `.worktrees/pipi-branding`.
- **Verification:** Focused installer tests passed 16/16 and welcome-branding tests passed 2/2 after initializing the existing pinned submodules and installing worktree dependencies. Full fresh checks then passed 30/30 installer tests, 180/180 deterministic extension tests, 22/22 file-search tests, exact submodule validation, TypeScript, formatting, and `git diff --check`. Installer failures observed before worktree dependency/submodule initialization were environment setup failures rather than product regressions. Installed the branch with repository dependencies skipped, removed the temporary primary-checkout package duplicate, and verified isolated Pipi 0.84.3 with branded `APP_NAME`/`APP_TITLE`, `pipi --help`, the exact `pipi --session-dir '/tmp/pipi sessions' --session test-session` formatter result, MCP 2.15.0, unchanged model overrides, and no unreviewed runtime install scripts.
- **Review:** Independent Terra initial review returned `READY` with no actionable introduced or regressed findings.
- **Pull request:** Opened [PR #27](https://github.com/blockedby/my-pi-setup/pull/27) from `fix/pipi-branding` to `main`. Rebased onto the latest `origin/main`; the only conflict was this operation record, resolved by retaining the merged 0.84.3 rollout facts and the branding entry.
- **Post-rebase verification:** The target preparation helper required regression reruns because of the resolved conflict. Fresh checks again passed 30/30 installer tests, 180/180 deterministic extension tests, 22/22 file-search tests, exact submodule validation, TypeScript, formatting, `git diff --check`, and the installed branded-runtime check.
- **Publish:** Force-pushed the rebased branch with lease; PR #27 points to the reviewed, post-rebase implementation and evidence.
- **Merge and rollout:** At the user's request, squash-merged [PR #27](https://github.com/blockedby/my-pi-setup/pull/27) as `e66caa9`, synchronized primary `main`, and ran the optimized rollout from the merged primary package. The target sync helper fast-forwarded `main` but could not remove the feature worktree while Git still treated it as containing submodules; after deinitializing those unchanged pinned submodules, the verified clean worktree required Git's double-force worktree removal. Deleted the merged local branch, removed its stale local Pipi package registration, and retained the remote branch.
- **Post-merge verification:** GitHub reports PR #27 merged; local `HEAD` equals `origin/main`; the branding feature worktree and local branch are absent; `npm run check:pipi-install` verifies Pipi 0.84.3, the branded launcher/resume command, MCP 2.15.0, install-script policy, and unchanged model overrides; and `pipi list` resolves this repository from the merged primary checkout rather than the removed feature worktree. No credential or auth-file content was accessed.
- **Pending:** Reload or restart this current Pipi session before visually checking the new PIPI welcome header.

## Operation entry: resolve plan-gh-backlog collision and pin latest source

- **Request:** Resolve the `plan-gh-backlog` skill collision between the primary checkout and `.worktrees/update-plan-gh-backlog`, and pin the latest upstream version.
- **Action:** Confirmed upstream `plan-gh-backlog` `main` currently ends at `5a179fb453c6b97ce5c93723319e691dac27bc18`, the already reviewed safe pin in open parent [PR #17](https://github.com/blockedby/my-pi-setup/pull/17). Removed the temporary update-worktree package registration that caused the duplicate skill, initialized the canonical primary submodules, and reinstalled Pipi from the primary checkout so only one package supplies `plan-gh-backlog` while PR #17 is refreshed onto current `main`. Preserved the read-only submodule source and unchanged `.gitmodules`/`config/submodules.json` URL and branch metadata.
- **Affected paths or values:** Parent gitlink `vendor/plan-gh-backlog` advances from `29136202437149b477e5d21317d82219fcc011bb` to `5a179fb453c6b97ce5c93723319e691dac27bc18`; this record also corrects the installation table to the existing reviewer pin `5c446e5`. Pipi runtime 0.84.3, MCP 2.15.0, model overrides, credentials, auth isolation, profiles, and quotas are unchanged.
- **Verification:** Upstream `refs/heads/main` resolves exactly to `5a179fb`; the child passed 16/16 unit tests, validated the bundled example, and produced its JSON implementation plan. Canonical closure review previously returned `READY`. After resolving operation-record conflicts during the rebase onto current `main`, fresh parent checks passed 30/30 installer tests, 180/180 deterministic extension tests, 22/22 file-search tests, exact submodule validation, TypeScript, formatting, and `git diff --check`. Current `pipi list` contains only the primary `pipi-alias` package and no update-worktree package registration.
- **Merge and rollout:** Force-pushed the refreshed branch with lease, squash-merged [PR #17](https://github.com/blockedby/my-pi-setup/pull/17) as `c3f9004`, synchronized primary `main`, checked out both exact canonical submodule pins, and reinstalled Pipi from the merged primary package. The sync helper fast-forwarded `main` but could not remove the feature worktree containing initialized submodules; cleanup completed after deinitializing that verified clean worktree and forcing its removal, then the primary submodules were reinitialized because Git's submodule registration is shared across worktrees. The merged local branch and duplicate live package entry are absent; remote branch history is retained.
- **Post-merge verification:** GitHub reports PR #17 merged; local `HEAD` equals `origin/main`; upstream and the parent gitlink both equal `5a179fb`; exact submodule validation and the installed Pipi check pass; and `pipi list` shows only the primary `pipi-alias` package, so a fresh session has one canonical `plan-gh-backlog` skill source.
- **Pending:** Reload or restart Pipi so the current process discards its pre-rollout skill catalog.
## Operation entry: add bounded small-feature pipeline

- **Request:** Add a new implementation pipeline in a separate PR with the fixed graph Luna implementer → Terra auditor → the same Luna fixes → done. The user declined a live/full feature-pipeline implementation run because this change should be made directly by analogy and covered thoroughly with deterministic tests.
- **Action:** Created branch `feat/small-feature-pipeline` in `.worktrees/small-feature-pipeline` from current `origin/main`. Added bounded selector `small-feature-pipeline` with a persistent read-only Sol orchestrator, one persistent Luna/medium implementation session, one independent read-only Terra/high canonical audit, and exactly one continuation to the original Luna session for remediation. The host enforces stage order, child cardinality, same-session reuse, structured implementation/audit reports, no Terra retry or re-audit, factual completion, and mutation boundaries. Updated automatic routing and nested dashboard support without changing the backward-compatible omitted selector default of `feature-pipeline`.
- **Affected paths or values:** `extensions/pipelines/{domain,controller,prompt,session,index,dashboard,plan-contract}.ts` and deterministic tests, `extensions/shared/child-session.ts` and its policy test, `README.md`, `docs/pipelines-v1-design.md`, this operation record, and the new feature worktree/branch. Runtime versions, dependencies, model overrides, credentials, MCP settings, submodule pins, direct subagents, raw workflows, existing feature/plan graph behavior, and installed Pipi state are unchanged.
- **Verification:** Focused pipeline/policy checks passed 45/45 after final acceptance hardening. The full deterministic suite passed 30/30 installer tests, 184/184 extension tests, and 22/22 file-search tests; exact submodule pins, aligned Pipi 0.84.3 metadata, TypeScript, formatting, and `git diff --check` passed. The first full run failed only because the new worktree's read-only submodules were not initialized; `git submodule update --init --recursive` restored the authoritative pins and the unchanged suite then passed. A canonical initial-mode self-review found no impact-3/4 blocking defect; acceptance inspection additionally denied delegated Codex/MCP/background tools to Luna, supplied Terra with the captured Git base/status/diff despite its read-only shell boundary, ensured Terra's full report is injected into same-session remediation, and cancels Sol on malformed-child failure. No independent live reviewer was started because the user explicitly requested direct implementation rather than model orchestration, and no live model backend or pipeline ran.
- **Pull request:** Committed the implementation as `f513a85`, pushed `feat/small-feature-pipeline`, and opened [PR #29](https://github.com/blockedby/my-pi-setup/pull/29) against `main`.
- **Target preparation:** Rebased onto `origin/main` after branding PRs #27/#28. The only conflict was this append-only operation record; resolved it by retaining the complete merged branding history and this small-feature entry. The rebased implementation commit is `b5c396b`.
- **Post-rebase verification:** Fresh checks passed 30/30 installer tests, 187/187 deterministic extension tests, 22/22 file-search tests, exact submodule validation, aligned Pipi 0.84.3 metadata, TypeScript, formatting, and `git diff --check`.
- **Publish:** Committed the post-rebase evidence and force-pushed the rebased branch with lease; PR #29 now targets current `main` with a clean worktree and the verified graph implementation.
- **Merge and rollout:** At the user's request, refreshed PR #29 onto the latest `main` after backlog-skill PRs #17/#30, preserving both append-only operation histories, then reran 30/30 installer tests, 187/187 deterministic extension tests, 22/22 file-search tests, exact submodule validation, Pipi version alignment, TypeScript, formatting, and `git diff --check`. Force-pushed with lease and squash-merged [PR #29](https://github.com/blockedby/my-pi-setup/pull/29) as `ed46903`, synchronized primary `main`, removed the verified feature worktree/local branch after deinitializing its shared submodules, reinitialized the primary canonical pins, and installed Pipi 0.84.3 from merged primary with repository dependencies skipped. Installed checks and `pipi list` confirm the branded runtime and a single primary package registration.
- **Pending:** Reload/restart Pipi before invoking `small-feature-pipeline` from a new session.

## Operation entry: explain small-pipeline Git evidence collection

- **Request:** Explain how the programmatic Git tools added for `small-feature-pipeline` work.
- **Action:** Clarified that the change adds internal host-side read-only Git evidence collection rather than a new public agent tool. At run start the controller captures `git rev-parse HEAD` as the review base. Before Terra starts, it collects bounded `git status --short --branch` and `git diff --no-ext-diff --no-color <captured-base> --`, then injects the base identity, `WORKTREE` head label, status, diff, and Luna's implementation report into Terra's context. Failures degrade to explicit unavailable evidence without mutating Git or aborting startup. Terra remains denied shell/edit/write/MCP/delegated mutation tools and can inspect reported or untracked paths with read-only repository tools.
- **Affected paths or values:** This operation record only. PR #29 source, Git state, installed Pipi state, credentials, model overrides, dependencies, and submodule pins are unchanged.
- **Verification:** Compared the explanation against `extensions/pipelines/controller.ts`, `session.ts`, and the deterministic captured-base/diff and tool-policy regressions in `controller.test.ts`. The implementation exposes no small-feature `git add`, commit, reset, checkout, merge, rebase, or push operation; the existing bounded `pipeline_git_status` tool remains specific to `plan-pipeline` roots.
- **Pending:** PR #29 is now merged and installed; reload/restart remains required for sessions created before that rollout.

## Operation entry: add captured Git evidence to feature-pipeline audits

- **Request:** After merging PR #29, add the same programmatic captured-base/status/diff evidence to the existing `feature-pipeline` audits in a separate PR. During PR review, replace the controller's chained definition/role string conditions with centralized role constants/unions and a typed policy contract.
- **Action:** Created `feat/feature-pipeline-git-evidence` in `.worktrees/feature-pipeline-git-evidence` from merged `origin/main`. Generalized the existing internal read-only Git evidence formatter so each of the four Luna feature-audit roles receives the run's captured base plus current status/diff when spawned, and the independent Terra final audit receives a newly collected snapshot after Luna remediation. Discovery roles remain unchanged; prior Luna reports are not injected into Terra, preserving its independent context. Refactored role selection into named feature-audit/final-audit/small-feature constants, an inferred Luna-audit role union, and `PIPELINE_CHILD_CONTEXT_POLICIES`; the controller now consumes one semantic `childContextPolicyFor` result instead of branching on role-name prefixes and definition-specific string literals. No public or mutating Git tool was added.
- **Affected paths or values:** `extensions/pipelines/domain.ts`, `controller.ts`, their deterministic tests, `README.md`, `docs/pipelines-v1-design.md`, this operation record, and the new branch/worktree. Runtime versions, installed Pipi state after PR #29, credentials, model overrides, MCP settings, dependencies, submodule pins, plan/small-feature graph behavior, raw workflows, and direct subagents are unchanged.
- **Verification:** Before review refactoring, focused controller checks passed 22/22 and full checks passed 30/30 installer tests, 188/188 deterministic extension tests, and 22/22 file-search tests. After centralizing role policies, fresh focused checks passed 23/23 and the full suite passed 30/30 installer tests, 189/189 deterministic extension tests, and 22/22 file-search tests; exact submodule validation, aligned Pipi 0.84.3 metadata, TypeScript, formatting, and `git diff --check` also passed. Coverage proves all four Luna audit roles receive the captured base/initial diff, Terra receives a fresh post-remediation diff, policy lookup is definition-specific, discovery/plan roles receive no implicit evidence, and small-feature prior-report behavior is preserved. Canonical initial-mode self-review found no impact-3/4 blocking defect; no independent live reviewer was started because live model backends were not authorized.
- **Pull request:** Committed as `55f2913`, pushed `feat/feature-pipeline-git-evidence`, and opened [PR #31](https://github.com/blockedby/my-pi-setup/pull/31) against `main`. Target preparation reported `rebase_status=up_to_date`, `content_changed=false`, and no regression rerun requirement.
- **Review refactor:** Committed the centralized typed role/context policy as `60d9c8e` and pushed it to PR #31. The branch is clean and remains aligned with the prepared target.
- **Merge and rollout:** At the user's request, squash-merged [PR #31](https://github.com/blockedby/my-pi-setup/pull/31) as `f06e84b`, fast-forwarded primary `main`, removed the verified feature worktree and local branch after deinitializing its shared submodules, restored the exact primary submodule pins, and installed from the merged primary package with repository dependencies skipped. `check:pipi-install` verifies Pipi 0.84.3, branded launcher/resume behavior, MCP 2.15.0, install-script policy, and unchanged model overrides; exact submodule validation passes; `pipi list` contains only the primary checkout for this package.
- **Pending:** Reload/restart Pipi sessions created before this rollout so they load the merged feature-audit evidence policies.

## Operation entry: collapse pipeline dashboard runs and open stage agents

- **Request:** In a new PR, keep pipeline runs collapsed by default, expand an individual run on confirmation instead of permanently showing every descendant, retain a red/yellow/green overall run status, and make stage rows such as a running `final-resolve` open their responsible agent from the dashboard.
- **Action:** Created `feat/collapsible-pipeline-runs` in `.worktrees/collapsible-pipeline-runs`. The dashboard now owns a session-scoped set of expanded run IDs: definition and run summaries remain visible, `Enter` toggles only the selected run, descendants are omitted from navigation while collapsed, and expansion plus stable selection survive an agent transcript/takeover round-trip. Run summaries include collapsed/expanded chevrons, textual status, and theme status glyphs mapping completed to green, failed/cancelled to red, and starting/running to yellow. Stage rows resolve to their responsible child or persistent Sol agent; `small-feature-pipeline` `final-resolve` reopens its persistent Luna implementer. Agent-row transcript/takeover and `x` cancellation behavior are unchanged. An attempted Codex delegation was stopped at the user's request, its workspace changes were fully restored, and the implementation was then produced directly.
- **Affected paths or values:** `extensions/pipelines/dashboard.ts`, `extensions/pipelines/dashboard.test.ts`, `extensions/pipelines/controller.test.ts`, and this operation record. Pipeline graphs, controller state transitions, child policies, runtime versions, dependencies, submodule pins, model overrides, credentials, installed Pipi state, direct subagents, and raw workflows are unchanged.
- **Verification:** Focused dashboard/controller checks pass 33/33, including default collapse, independent expansion, stable selection, all run-status glyph mappings, feature `final-resolve` → Sol, and small-feature `final-resolve` → persistent Luna. TypeScript and formatting pass. The first full run failed only because the new worktree's read-only submodules were not initialized; after `git submodule update --init --recursive`, exact submodule validation passed and the fresh full deterministic suite passed 30/30 installer tests, 193/193 extension tests, and 22/22 file-search tests. A direct initial-mode review of the complete diff found no blocking or follow-up defect. No live pipeline or model backend was invoked.
- **Pull request:** Committed the implementation as `aa76392`, pushed `feat/collapsible-pipeline-runs`, and opened [PR #34](https://github.com/blockedby/my-pi-setup/pull/34) against current `main`; target preparation reported the branch already up to date with no content-changing rebase.
- **Merge without installation:** At the user's request, squash-merged [PR #34](https://github.com/blockedby/my-pi-setup/pull/34) as `ebf9958` and fast-forwarded primary `main`. Removed the verified feature worktree and local branch after deinitializing its shared submodules, then restored the exact primary submodule registrations. Deliberately did not run the Pipi installer, rollout command, or `/reload`; the current Pipi process remains unchanged.
- **Pending:** Install and reload the merged dashboard only when the user explicitly requests rollout.

## Operation entry: restore branded Pipi discovery in Herdr

- **Request:** Investigate why newly restarted Pipi terminals disappeared from Herdr's Agents list, then add the agreed compatibility fix to Pipi installation and upgrades in a separate pull request: when Herdr is installed, install its official Pi integration into isolated Pipi.
- **Diagnosis:** Live `herdr pane process-info` and `agent list` evidence showed older visible terminals running with foreground name `pi`, while newly branded terminals run with foreground name `pipi` and remain `unknown`. Pipi branding sets Pi's supported `piConfig.name` to `pipi`, which Pi copies into `process.title`; Herdr 0.8.0 native process detection recognizes `pi`, not the custom name. PR #31 and its installer are unrelated; restarting after its rollout exposed the earlier branding compatibility gap. Herdr's documented Agents model remains one recognized foreground agent per terminal pane, so this fix targets root Pipi panes rather than in-process Luna/Terra sessions.
- **Action:** Created `fix/herdr-pipi-integration` in `.worktrees/herdr-pipi-integration` from current `origin/main`. Updated the installer to detect an executable `herdr`, invoke its official `integration install pi` command without a shell and with `PI_CODING_AGENT_DIR` fixed to Pipi's isolated agent directory, verify the expected extension file, and fail clearly if a detected Herdr cannot install it. Hosts without Herdr skip the optional integration. Because Pipi upgrade rollout already calls the same installer, no parallel update hook was added. Extended installed-state validation, deterministic fake-Herdr coverage, setup documentation, and the README with a direct link to Herdr's official repository.
- **Affected paths or values:** `scripts/install.mjs`, `scripts/check-pipi-install.mjs`, `tests/scripts/install.test.mjs`, `README.md`, `SETUP.md`, this record, and the new branch/worktree. Pipi remains branded as `pipi`; runtime/dependency versions, model overrides, credentials, MCP settings, submodule pins, pipeline graphs, direct subagent behavior, and Herdr's internal-agent semantics are unchanged.
- **Verification:** Focused installer checks passed 20/20. Before target refresh, the full deterministic suite passed 34/34 script/installer/submodule tests, 189/189 extension tests, and 22/22 file-search tests. An isolated smoke with the real local Herdr 0.8.0 CLI and a temporary home/agent directory created the official managed integration and reported `pi: current (v8)` without touching the real Pipi directory. Source inspection confirms the official integration reports agent label `pi`, activates only under Herdr, and ignores headless `print` sessions used by in-process children. No live model backend ran.
- **Pull request:** Pushed `fix/herdr-pipi-integration` and opened [PR #33](https://github.com/blockedby/my-pi-setup/pull/33) against `main`. Added the requested README sentence linking directly to the [official Herdr repository](https://github.com/herdrdev/herdr).
- **Target refresh:** `main` advanced through dashboard PRs #34/#35. Rebasing exposed only the append-only operation-record conflict; resolution preserves the complete dashboard merge-without-rollout entry followed by this Herdr entry. Fresh post-rebase checks passed 34/34 script/installer/submodule tests, 193/193 extension tests, 22/22 file-search tests, TypeScript, formatting, exact submodule validation, aligned Pipi 0.84.3 metadata, and `git diff --check`.
- **Merge and initial rollout:** At the user's request, force-pushed the verified target refresh, squash-merged [PR #33](https://github.com/blockedby/my-pi-setup/pull/33) as `2bee9cf`, synchronized primary `main`, removed its feature worktree/local branch after the usual submodule deinitialization cleanup, restored exact submodule registrations, and installed from merged primary. Installation and installed-state checks passed, and Herdr reported `pi: current (v8)` at `~/.pipi/agent/extensions/herdr-agent-state.ts`.
- **Runtime acceptance correction:** A fresh temporary Herdr workspace exposed that installation presence alone was insufficient: branded `pipi` remained `unknown`, and Herdr ignored a manual official `herdr:pi` lifecycle report until process detection established Pi identity. A manual custom report was accepted, proving the pane/socket path itself worked. Herdr's documented wrapper mechanism resolved the actual boundary: launching the same branded Pipi with pane-scoped `HERDR_AGENT=pi` immediately produced agent `pi`, official `herdr:pi` session identity, authoritative idle state, and `screen_detection_skip_reason: full_lifecycle_hook_authority`.
- **Corrective action:** Created `fix/herdr-pipi-launch-hint` from merged `origin/main`. The managed launcher now exports `HERDR_AGENT=pi` only when `HERDR_ENV=1`; it is not global outside Herdr. Added deterministic inside/outside-Herdr launcher coverage, installed-state validation, and aligned README/SETUP wording. The official integration remains required when Herdr is installed; internal headless Luna/Terra sessions remain unaffected.
- **Corrective verification:** Focused installer checks passed 21/21, including proof that the launcher omits the hint outside Herdr and sets exactly `pi` inside it. The full fresh suite passed 35/35 script/installer/submodule tests, 193/193 extension tests, and 22/22 file-search tests; TypeScript, formatting, exact submodules, aligned Pipi 0.84.3 metadata, and `git diff --check` passed. Before coding, a fresh temporary pane launched with `HERDR_AGENT=pi` reached official agent `pi`, carried a resumable `herdr:pi` session path, reported authoritative idle state, and skipped screen detection under full lifecycle hook authority.
- **Corrective merge and final rollout:** Opened and squash-merged [PR #37](https://github.com/blockedby/my-pi-setup/pull/37) as `877655c` under the user's existing authorization, synchronized primary `main`, removed the corrective worktree/local branch after deinitializing its shared submodules, restored exact primary pins, and reinstalled Pipi from merged primary with repository dependencies skipped. Installed validation confirms Pipi 0.84.3, MCP 2.15.0, unchanged model overrides, the Herdr-scoped launcher hint, and official Herdr Pi integration `current (v8)`. This rollout also loads the previously merged dashboard PR #34 that had intentionally not been installed earlier.
- **Final runtime acceptance:** Created a fresh temporary Herdr workspace without manually supplying any hint and launched the installed `pipi` command. Herdr identified the pane as agent `pi`, reported `idle`, attached the official `herdr:pi` path-based resumable session, set `screen_detection_skipped=true`, and explained `full_lifecycle_hook_authority`; the temporary workspace was then closed. Primary `main` is clean and aligned with `origin/main`.
- **Pending:** Restart or reload Pipi sessions launched before this rollout; newly launched sessions are already covered. No further repository or runtime change is pending.

## Operation entry: add a concise README pipeline overview

- **Request:** Briefly explain in the README what pipelines are, which definitions exist, and how they work, then open a PR for review.
- **Action:** Added two introductory paragraphs to `README.md` describing fixed bounded Sol-orchestrated graphs, limited Luna/Terra roles, validated reports and factual handoffs; summarized `small-feature-pipeline`, `feature-pipeline`, and `plan-pipeline`; and explained the collapsed `/pipelines` dashboard, textual color status, expansion, and stage-agent opening behavior before the existing detailed reference.
- **Affected paths or values:** `README.md` and this operation record only. Pipeline behavior, installed Pipi state, dependencies, runtime versions, model overrides, submodule pins, credentials, and current session resources are unchanged.
- **Verification:** Reviewed the wording against the three current pipeline definitions and merged dashboard behavior; `git diff --check` passes.
- **Pull request:** Committed as `67e7a0f`, pushed `docs/readme-pipelines-overview`, and opened [PR #36](https://github.com/blockedby/my-pi-setup/pull/36) against current `main`; target preparation reported no rebase was needed.
- **Review refinement:** In response to the user's PR feedback, replaced the dry implementation-oriented introduction with two shorter, more direct paragraphs: why pipelines help, who does what, when to choose each definition, and how to read/control `/pipelines` at a glance.
- **Target refresh:** After the user's merge approval, rebased PR #36 onto the latest `main`. The only conflict was the append-only operation record; resolution preserves the complete merged Herdr rollout history followed by this README entry. The documentation diff and `git diff --check` pass.
- **Pending:** Force-push the refreshed branch with lease, merge PR #36, and synchronize `main`; do not reinstall or reload Pipi.
