# Pipi setup

Pipi is a side-by-side launcher with its own pinned Pi runtime. It does not replace `pi` or write to regular Pi's runtime, settings, or sessions.

## Requirements

- Node.js and npm
- `codex` in `PATH` for Codex subagents and Codex-backed tools
- optional sibling checkout `../pi-codex` (`pi-codex-tools`)
- npm access for the initial isolated Pi runtime and `pi-mcp-adapter` install
- Google Chrome or Chromium plus `npx` for `chrome-devtools-mcp`

The file-search extension uses system `fd`/`fdfind` and `rg` when available. If either is missing, it can download its supported fallback binary into `~/.pipi/agent/bin` at first Pipi startup.

## Install

From this repository checkout, run:

```sh
npm run install:pipi
```

The installer reproducibly installs root and extension dependencies from their lockfiles, then creates:

- `~/.local/bin/pipi` — launcher for the pinned Pipi-owned Pi runtime
- `~/.pipi/agent/npm` — exact isolated Pi runtime and MCP adapter packages
- `~/.pipi/agent/settings.json` — Pipi-only settings
- `~/.pipi/sessions` — Pipi-only session storage

It installs the Pi version pinned by this checkout and `pi-mcp-adapter` under `~/.pipi/agent/npm`, loads this checkout as a local Pi package, and adds sibling `../pi-codex` when that directory contains the `pi-codex-tools` package. The isolated npm manifest records reviewed, version-pinned install-script approvals for `@google/genai@1.52.0` and `protobufjs@7.6.5`; the installer does not approve arbitrary pending scripts. The local package loads the canonical code-review skill directly from the initialized, commit-pinned `vendor/gpt5.6-reviewer` submodule. The installer copies the vendored `pi-agent-setup` browser skill into Pipi-owned paths and removes the previously added `pi-subagents` extension, named browser agent, and agent-only skill dependency. It also seeds missing `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` values from regular Pi settings while leaving the regular settings file unchanged. Existing unrelated Pipi settings, package entries, and MCP servers are preserved.

Add `~/.local/bin` to `PATH` if necessary, then verify the launcher:

```sh
pipi --version
```

Re-running the installer is safe and idempotent. For an already prepared development checkout where the isolated Pi runtime and MCP adapter are already present, `--skip-dependencies` preserves those packages while still refreshing the browser skill and MCP assets and removing the retired `pi-subagents` integration:

```sh
npm run install:pipi -- --skip-dependencies
```

Custom executable and package locations are supported:

```sh
npm run install:pipi -- --pi /path/to/pi --codex-tools /path/to/pi-codex
```

## Evidence-driven code review

Pipi loads one canonical `code-review` skill from:

```text
vendor/gpt5.6-reviewer/skills/code-review
```

The pinned submodule also contains the independent reviewer role, verifier prompt, JSON contracts, examples, and optional Python CLI. Pipi does not duplicate the skill under the host `skills/` directory and does not fetch or advance the submodule or install or execute the Python CLI during setup.

For a fresh checkout, clone recursively:

```sh
git clone --recurse-submodules https://github.com/blockedby/my-pi-setup.git
```

For an existing checkout, initialize the reviewer source before installation:

```sh
git submodule update --init --recursive
```

Run `npm run check:submodules` to verify `.gitmodules`, the parent gitlink, initialized/clean child state, required files, package skill path, and duplicate absence.

## MCP adapter

Pipi uses the same adapter version observed in regular Pi, but installs its own package copy:

```text
npm:pi-mcp-adapter@2.15.0
~/.pipi/agent/npm/node_modules/pi-mcp-adapter
```

Open Pipi and use `/mcp` or `/mcp setup`. Other useful commands include `/mcp tools`, `/mcp reconnect`, and `/mcp-auth <server>`.

The installer deliberately does not copy or link `~/.pi/agent/mcp.json` because that file can contain server credentials or secret-bearing environment fields. Standard shared configs such as `~/.config/mcp/mcp.json` and project `.mcp.json` files remain discoverable. Use `/mcp setup` to create or adopt additional isolated Pipi configuration.

## Browser Chrome skill and MCP

The installer vendors the browser skill from the local `pi-agent-setup` checkout and installs these isolated Pipi assets:

```text
~/.pipi/agent/skills/browser-chrome
~/.pipi/agent/mcp.json
```

The optional `pi-subagents` named-agent extension is not installed. Browser work uses the skill and MCP tools directly from the main Pipi session or the creator setup's existing subagent system.

Pipi's MCP config contains three lazy browser servers that point only to Pipi-owned skill scripts:

```text
browser-chrome-control
browser-chrome-headed
browser-chrome-headless
```

Use `browser-chrome-control` first. Choose disposable headless mode for public/local checks. Use headed persistent mode only when the task needs your current login, saved session, password manager, extensions, or profile. Headed DevTools access can control private browser data, so do not use it for anonymous checks.

Restart Pipi or use `/reload` after installation so the browser skill and MCP configuration are refreshed.

## Isolation and authentication

The launcher executes `~/.pipi/agent/npm/node_modules/.bin/pi` after exporting a persistent profile marker and both isolation variables:

```text
PIPI_PROFILE=1
PI_CODING_AGENT_DIR=~/.pipi/agent
PI_CODING_AGENT_SESSION_DIR=~/.pipi/sessions
```

In-process Pi child sessions inherit this environment, so they load Pipi's settings and resources without starting another `pipi` process.

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

## Updating the pinned Pi runtime

Use the repository-level `update-pipi` skill. It runs the same three commands used for manual maintenance:

```sh
npm run check:pipi-changelog -- <version>
npm run update:pipi -- <version>
npm run complete:pipi-upgrade
```

The first command uses `curl` to show relevant coding-agent changelog entries before a minor or major upgrade and highlights a `Breaking Changes` section; patch upgrades skip that fetch. Inspect its output before continuing. The updater then checks that the aligned Pi AI, coding-agent, and TUI packages are published, pins lockfile resolution to the requested release while retaining caret declarations, and rolls back the manifest and lockfile if the update fails. The completion command runs deterministic source verification, installs the isolated runtime, and verifies the runtime, MCP pin, install-script policy, and model overrides.

## Development checks

```sh
npm run check:pipi-version
npm run check:submodules
npm run test:deterministic
npm run check
npm run format:check
node --test vendor/pi-agent-setup/skills/browser-chrome/control-mcp/*.test.mjs
```

Installer tests use temporary home directories and fake `pi`/`codex` executables; they never write to the real user configuration. Browser control tests do not open an authenticated profile. `npm test` is deterministic and excludes live Claude/Codex backend tests; run those explicitly with `npm run test:live` only when live backend calls are authorized.

See [docs/pipi-setup-record.md](docs/pipi-setup-record.md) for the complete local change record and pending steps.
