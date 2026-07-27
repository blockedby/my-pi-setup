# Pipi setup record

This is the durable, user-facing record for the local `pipi` setup. Append future Pipi requests here after they are implemented or clearly identified as pending. Never record tokens, API keys, OAuth credentials, cookies, or auth-file contents.

## Current installation

| Item                                    | Location / value                                         |
| --------------------------------------- | -------------------------------------------------------- |
| Source checkout                         | `/home/kcnc/code/tools/pipi-alias`                       |
| Source branch                           | `feat/pipi-alias`                                        |
| Launcher                                | `/home/kcnc/.local/bin/pipi`                             |
| Pi executable used                      | `/home/kcnc/.local/bin/pi`                               |
| Pipi settings                           | `/home/kcnc/.pipi/agent/settings.json`                   |
| Pipi sessions                           | `/home/kcnc/.pipi/sessions`                              |
| Creator setup package                   | `/home/kcnc/code/tools/pipi-alias`                       |
| Codex tools package                     | `/home/kcnc/code/tools/pi-codex`                         |
| MCP adapter                             | `npm:pi-mcp-adapter@2.15.0`                              |
| Isolated MCP package files              | `/home/kcnc/.pipi/agent/npm/node_modules/pi-mcp-adapter` |
| Named-agent runtime                     | `npm:pi-subagents@0.37.0`                                |
| Browser Chrome skill                    | `/home/kcnc/.pipi/agent/skills/browser-chrome`           |
| Browser agent                           | `/home/kcnc/.pipi/agent/agents/chrome-browser-agent.md`  |
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
- Pipi's MCP adapter and named-agent runtime are isolated under `~/.pipi/agent/npm`.
- Browser skills, agent definition, and MCP commands are Pipi-owned copies under `~/.pipi/agent`.
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

### 9. Browser Chrome skill, agent, and MCP

- Vendored the exact `browser-chrome` skill and `chrome-browser-agent.md` from `/tmp/opencode/pi-agent-setup-main`.
- Vendored and installed the agent's required `aad-task-package` skill dependency.
- Installed both skills under `~/.pipi/agent/skills` with private file modes and executable owner-only shell scripts.
- Installed the named agent at `~/.pipi/agent/agents/chrome-browser-agent.md` without changing its prompt/frontmatter.
- Pinned and isolated `npm:pi-subagents@0.37.0` so the named browser agent is discoverable alongside the creator setup's separate subagent tools.
- Updated isolated npm installation to install all pinned Pi packages in one transaction, preventing npm from pruning one package while adding another.
- Created Pipi's own `mcp.json` with exactly these browser entries:
  - `browser-chrome-control`
  - `browser-chrome-headed`
  - `browser-chrome-headless`
- Pointed every browser MCP command at Pipi-owned scripts; no regular Pi path, config, credential, or browser data was copied.
- Preserved unrelated Pipi MCP entries during installer reruns.
- Verified the control MCP exposes four policy tools and disposable headless MCP exposes 29 Chrome DevTools tools.
- Verified the headless smoke probe cleaned up its temporary Chrome process and did not use an authenticated profile.
- Verified `pi-subagents` discovers `chrome-browser-agent` with model `openai-codex/gpt-5.6-terra`, skills `browser-chrome,aad-task-package`, and tools `read,write,bash,mcp`.

## Current package sources

The installer keeps these package sources in Pipi settings:

```text
/home/kcnc/code/tools/pipi-alias
npm:pi-mcp-adapter@2.15.0
npm:pi-subagents@0.37.0
/home/kcnc/code/tools/pi-codex
```

Unrelated user-added Pipi packages are preserved.

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
6. Add the `browser-chrome` skill, `chrome-browser-agent`, and browser MCP servers from `pi-agent-setup`, and log the work — completed and recorded in section 9.
7. Add short README tables explaining the installed agents and skills — completed in `README.md`.

## Pending steps explicitly connected to user requests

1. **Authenticate Pipi for model and named-agent use.** Run `pipi`, then `/login`, unless auth sharing is explicitly requested. The default remains separate.
2. **Reload after this installation.** Start a new Pipi session or run `/reload` so the new `pi-subagents`, skill, agent, and MCP entries are loaded.
3. **Choose browser mode safely.** Use disposable headless mode by default. Use headed persistent mode only when a future requested task needs the current browser login/profile.
4. **Choose any additional MCP servers.** Browser MCP is configured. Use `/mcp setup` only for other servers; importing regular Pi's secret-bearing config requires a separate explicit decision.
5. **Keep this record current.** Append future requested Pipi changes, their evidence, and any remaining action here.

## Discussed ideas that are not requested implementation

These were discussed or explained, but they are not active work:

- Add named editable agent-prompt presets such as planner, implementer, and reviewer.
- Allow subagents to create nested subagents. The current leaf-worker design intentionally blocks this and would need depth, cost, permission, and cancellation limits before changing.

## Verification commands

Use targeted checks that do not call paid models:

```sh
cd /home/kcnc/code/tools/pipi-alias
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
- Record future completed and pending work in this file.
