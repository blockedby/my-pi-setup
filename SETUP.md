# Pipi setup

Pipi is a side-by-side launcher for the existing Pi CLI. It does not replace `pi` or write to regular Pi's settings.

## Requirements

- Node.js and npm
- an existing `pi` executable in `PATH`
- `codex` in `PATH` for Codex subagents and Codex-backed tools
- optional sibling checkout `../pi-codex` (`pi-codex-tools`)
- npm access for the initial isolated `pi-mcp-adapter` and `pi-subagents` install
- Google Chrome or Chromium plus `npx` for `chrome-devtools-mcp`

The file-search extension uses system `fd`/`fdfind` and `rg` when available. If either is missing, it can download its supported fallback binary into `~/.pipi/agent/bin` at first Pipi startup.

## Install

From this repository checkout, run:

```sh
npm run install:pipi
```

The installer reproducibly installs root and extension dependencies from their lockfiles, then creates:

- `~/.local/bin/pipi` — launcher for the resolved existing `pi` executable
- `~/.pipi/agent/settings.json` — Pipi-only settings
- `~/.pipi/sessions` — Pipi-only session storage

It loads this checkout as a local Pi package, adds sibling `../pi-codex` when that directory contains the `pi-codex-tools` package, and registers pinned `pi-mcp-adapter` and `pi-subagents` packages. Both npm packages are installed together under `~/.pipi/agent/npm` so older global packages cannot shadow them or one isolated install cannot prune the other. The installer copies the vendored `pi-agent-setup` browser skill, its `aad-task-package` dependency, and `chrome-browser-agent` into Pipi-owned paths. It also seeds missing `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` values from regular Pi settings while leaving the regular settings file unchanged. Existing unrelated Pipi settings, package entries, and MCP servers are preserved.

Add `~/.local/bin` to `PATH` if necessary, then verify the launcher:

```sh
pipi --version
```

Re-running the installer is safe and idempotent. For an already prepared development checkout with both isolated npm packages already present, `--skip-dependencies` skips all dependency installs while still refreshing browser skill/agent/MCP assets:

```sh
npm run install:pipi -- --skip-dependencies
```

Custom executable and package locations are supported:

```sh
npm run install:pipi -- --pi /path/to/pi --codex-tools /path/to/pi-codex
```

## MCP adapter

Pipi uses the same adapter version observed in regular Pi, but installs its own package copy:

```text
npm:pi-mcp-adapter@2.15.0
~/.pipi/agent/npm/node_modules/pi-mcp-adapter
```

Open Pipi and use `/mcp` or `/mcp setup`. Other useful commands include `/mcp tools`, `/mcp reconnect`, and `/mcp-auth <server>`.

The installer deliberately does not copy or link `~/.pi/agent/mcp.json` because that file can contain server credentials or secret-bearing environment fields. Standard shared configs such as `~/.config/mcp/mcp.json` and project `.mcp.json` files remain discoverable. Use `/mcp setup` to create or adopt additional isolated Pipi configuration.

## Browser Chrome skill, agent, and MCP

The installer vendors these assets from the local `pi-agent-setup` checkout and installs them into isolated Pipi state:

```text
~/.pipi/agent/skills/browser-chrome
~/.pipi/agent/skills/aad-task-package
~/.pipi/agent/agents/chrome-browser-agent.md
~/.pipi/agent/mcp.json
```

It also registers and installs `npm:pi-subagents@0.37.0`, which discovers the named `chrome-browser-agent`. The creator setup's separate `subagent_spawn` extension remains installed; the two systems use different parent tools.

Pipi's MCP config contains three lazy browser servers that point only to Pipi-owned skill scripts:

```text
browser-chrome-control
browser-chrome-headed
browser-chrome-headless
```

Use `browser-chrome-control` first. Choose disposable headless mode for public/local checks. Use headed persistent mode only when the task needs your current login, saved session, password manager, extensions, or profile. Headed DevTools access can control private browser data, so do not use it for anonymous checks.

Restart Pipi or use `/reload` after installation. The named browser agent requires Pipi model authentication (`/login`) before it can execute a model turn.

## Isolation and authentication

The launcher exports both isolation variables before executing Pi:

```text
PI_CODING_AGENT_DIR=~/.pipi/agent
PI_CODING_AGENT_SESSION_DIR=~/.pipi/sessions
```

Pipi does not copy or share `~/.pi/agent/auth.json` by default. Authenticate Pipi independently, or explicitly opt in to sharing regular Pi auth through a symlink:

```sh
npm run install:pipi -- --share-auth
```

The installer refuses to overwrite an existing Pipi auth file. It never copies auth secret bytes.

## Uninstall

Remove only the managed launcher and preserve Pipi settings/sessions:

```sh
npm run uninstall:pipi
```

Remove the launcher plus all Pipi settings, auth links, downloaded tools, and sessions:

```sh
npm run uninstall:pipi -- --purge
```

The uninstaller refuses to remove a `pipi` launcher that lacks its managed-file marker. Neither uninstall mode changes regular Pi files.

## Development checks

```sh
npm run test:installer
npm run check
npm run format:check
node --test vendor/pi-agent-setup/skills/browser-chrome/control-mcp/*.test.mjs
```

Installer tests use temporary home directories and fake `pi`/`codex` executables; they never write to the real user configuration. Browser control tests do not open an authenticated profile. Run the broad `npm test` command only when live backend calls are explicitly authorized: upstream tests can detect installed Claude/Codex CLIs and invoke them.

See [docs/pipi-setup-record.md](docs/pipi-setup-record.md) for the complete local change record and pending steps.
