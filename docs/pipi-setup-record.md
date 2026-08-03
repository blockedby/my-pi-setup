# Pipi setup record

This is the durable, user-facing record for the local `pipi` setup. Append future Pipi requests here after they are implemented or clearly identified as pending. Never record tokens, API keys, OAuth credentials, cookies, or auth-file contents.

## Current installation

| Item                                    | Location / value                                         |
| --------------------------------------- | -------------------------------------------------------- |
| Source checkout                         | `/home/kcnc/code/tools/pipi-alias`                       |
| Source branch                           | `main`                                                   |
| Launcher                                | `/home/kcnc/.local/bin/pipi`                             |
| Pi executable used                      | `/home/kcnc/.local/bin/pi`                               |
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
| Browser MCP config                      | `/home/kcnc/.pipi/agent/mcp.json`                        |
| Theme                                   | `github-dark-default`                                    |
| Pi version at initial acceptance        | `0.82.1`                                                 |
| Codex CLI version at initial acceptance | `0.145.0`                                                |

## Isolation contract

- `pipi` uses the existing Pi executable; it is not a second global Pi binary.
- The launcher exports `PI_CODING_AGENT_DIR=/home/kcnc/.pipi/agent`.
- The launcher exports `PI_CODING_AGENT_SESSION_DIR=/home/kcnc/.pipi/sessions`.
- Regular Pi settings, sessions, auth, and MCP override files remain under `/home/kcnc/.pi/agent`.
- Pipi auth is separate by default. No auth secret bytes were copied.
- Pipi's MCP adapter is isolated under `~/.pipi/agent/npm`.
- The browser skill and MCP commands are Pipi-owned copies under `~/.pipi/agent`.
- The canonical code-review skill is loaded directly from the initialized, commit-pinned reviewer submodule; no duplicate host copy is loaded.
- The installer never fetches or advances the submodule, and its optional Python CLI is not installed or executed by Pipi setup.
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
