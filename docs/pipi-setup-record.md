# Pipi setup record

This is the durable, user-facing record for the local `pipi` setup. Append future Pipi requests here after they are implemented or clearly identified as pending. Never record tokens, API keys, OAuth credentials, cookies, or auth-file contents.

## Current installation

| Item                                    | Location / value                                         |
| --------------------------------------- | -------------------------------------------------------- |
| Source checkout                         | `/home/kcnc/code/tools/pipi-alias`                       |
| Source branch                           | `feat/evidence-driven-reviewer-subrepo`                  |
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
- Set `openai-codex/gpt-5.6-sol` to a 500,000-token context window.
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

## Pending steps explicitly connected to user requests

1. **Authenticate Pipi for model use.** Run `pipi`, then `/login`, unless auth sharing is explicitly requested. The default remains separate.
2. **Reload after this installation.** Start a new Pipi session or run `/reload` so the browser skill/MCP configuration and canonical evidence-driven code-review skill are refreshed.
3. **Choose browser mode safely.** Use disposable headless mode by default. Use headed persistent mode only when a future requested task needs the current browser login/profile.
4. **Choose any additional MCP servers.** Browser MCP is configured. Use `/mcp setup` only for other servers; importing regular Pi's secret-bearing config requires a separate explicit decision.
5. **Keep this record current.** `AGENTS.md` now requires every user-requested Pipi operation to append the request, action, affected paths or values, verification, and pending steps here without secrets.
6. **Remove disposable acceptance files when no longer needed.** `/tmp/pipi-submodule-install-check` contains only temporary clones, fake executables, isolated homes, logs, a wheel, and a virtual environment created for this test.

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
