# Pipi setup

Pipi is a side-by-side launcher with its own pinned Pi runtime. It does not replace `pi` or write to regular Pi's runtime, settings, or sessions.

## Requirements

- Bun 1.4.0 or newer, stable channel, as both JavaScript runtime and package manager
- Node.js 22.19.0 or newer only for the permission-restricted workflow sandbox
- `codex` in `PATH` for Codex subagents and Codex-backed tools
- initialized Git submodules (`git submodule update --init --recursive`)
- registry access for Bun's initial frozen dependency install
- Google Chrome or Chromium for `chrome-devtools-mcp`
- reviewed shared `browser-chrome`, `frontend-quality`, and `code-review` skills under `~/.agents/skills` (existing developer symlinks are supported; see [shared skill ownership](docs/shared-skills.md))

The file-search extension uses system `fd`/`fdfind` and `rg` when available. Native Git, shells, Chrome, Codex, Claude, and platform process tools remain external executable boundaries.

Pipi does not install, download, replace, or manage Bun itself. CachyOS and Arch users can install the prerequisite with `sudo pacman -Syu bun`; users on other platforms should follow the [official Bun installation instructions](https://bun.sh/docs/installation). Confirm that `bun --version` reports a stable supported version before continuing.

## Install

```sh
git submodule update --init --recursive
bun run install:pipi
```

The installer accepts `--bun /absolute/path/to/bun` or `PIPI_BUN_RUNTIME`. It rejects missing, old, or prerelease Bun before creating managed state.

Installation creates:

- `~/.local/bin/pipi` — managed Bun launcher
- `~/.pipi/agent/runtime` — isolated, frozen Bun runtime containing Pi, unchanged `pi-multi-pass@1.5.1`, and `chrome-devtools-mcp`
- `~/.pipi/agent/cache/bun` — Pipi-owned Bun package cache
- `~/.pipi/agent/settings.json`, `models.json`, and `mcp.json` — isolated settings, tracked model overrides (seeded only when missing), and MCP configuration
- `~/.pipi/sessions` — isolated sessions

The isolated manifest and lock are copied from `config/pipi-runtime/` and installed with `bun install --frozen-lockfile`. Required dependency lifecycle scripts are narrowly trusted only for `@google/genai` and `protobufjs`. Browser MCP is pinned to `chrome-devtools-mcp@1.10.1`. Generated MCP entries and adapter scripts under `~/.pipi/agent/adapters/browser-chrome` use the recorded absolute Bun and local pinned entrypoint. The adapter is not a skill, and does not include `SKILL.md` or a separate `install-local.sh` configuration writer. `PIPI_BUN_RUNTIME` may be unset on every installed browser entrypoint; if set, it must exactly equal the recorded absolute Bun. Control startup also verifies that the recorded executable remains executable and reports the stable version recorded at install time. Alternate or invalid runtime/package overrides fail before server startup instead of enabling registry resolution or another package manager.

The installer loads this checkout, the pinned backlog skill, and read-only `vendor/pi-codex`. Canonical browser, frontend-quality, and reviewer skills are consumed from `~/.agents/skills`, not duplicated in PiPi's skill directory or reviewer package exposure. Shared repositories and development symlink targets remain user-owned. Codex-tool dependencies are declared at the parent root and resolved by the root Bun lock; the immutable vendor lock remains source metadata and is not executed. Existing unrelated Pipi settings and MCP servers are preserved. Auth bytes are never copied.

Add `~/.local/bin` to PATH and verify:

```sh
pipi --version
```

If older PiPi skill copies are present, installation refuses implicit removal. After reviewing their differences, use `bun run install:pipi -- --adopt-shared-skills` to preserve those copies and adopt shared skills. Backups are retained under `~/.pipi/agent/backups/shared-skill-migration-v1/`, including the affected settings/MCP configuration and absence metadata. Existing backups are never overwritten. See [migration safety](docs/shared-skills.md#migration-safety).

Re-running installation is idempotent. Every normal install and reinstall stages a fresh isolated runtime from `config/pipi-runtime/bun.lock`, runs the frozen Bun install, validates the required Pi and browser entrypoints and the multi-pass package version/extension, and atomically activates the staged result. Existing mutable runtime contents are never reused. Browser target and rollback paths use no-follow occupancy checks, so a dangling managed browser symlink is replaced without touching its external referent and can be restored exactly after a caught failure. One exclusive per-HOME installer lock records host, PID, boot, process-start identity, and a random token in an atomically created symlink. A live same-host or foreign/ambiguous owner is preserved and refused; a demonstrably dead same-host owner and its private stage are recovered. Malformed ownership fails closed with an explicit manual-removal instruction. The complete managed agent tree and launcher are prepared from a private staged snapshot; caught failures, including late Herdr/config/link/activation failures, restore prior bytes, material modes, symlink targets, presence, and managed directories. Auth link metadata is copied without reading auth secret bytes. `--skip-repository-dependencies` skips only the root workspace frozen install; it still performs the fresh isolated runtime installation.

The normal root `bun install --frozen-lockfile` is a repository preflight/cache boundary that runs before the managed HOME transaction. It may prepare or repair repository `node_modules` and Bun cache state, and those package-manager outputs are intentionally not snapshotted or rolled back if a later managed-HOME step fails. Tracked manifests and `bun.lock` remain authoritative and unchanged; the preflight is safe to rerun on the next normal install. This repository boundary does not weaken rollback of `~/.pipi` managed state.

## Lockfile and workspace policy

`bun.lock` is the single authoritative repository lock for the root and all nine extension package roots. `package.json` declares `extensions/*` as workspaces. Effect/TSGO and Claude versions are overridden to the pre-migration resolved versions to avoid unrelated upgrades. The root postinstall sequences extension compiler preparation within one install invocation so workspace lifecycle tasks do not race while patching the shared TypeScript binary. Separate root preflights run concurrently against the same checkout are not inter-process serialized; avoid that unsupported operation until a repository-scoped preparation lock is implemented.

`config/pipi-runtime/bun.lock` is the only additional first-party lock. It is intentionally separate because the installed Pipi runtime is an independent deployment root under a disposable or user-selected HOME. Root and per-extension legacy locks are forbidden by `assertBunLockPolicy`; missing or stale Bun locks fail frozen installation.

The root trusted dependency list is exactly `@google/genai`, `msgpackr-extract`, and `protobufjs`. The isolated runtime list is exactly `@google/genai` and `protobufjs`. Workspace-owned Effect compiler patch commands are explicit Bun commands, not dependency trust grants.

## Submodules

Pipi uses pinned, read-only submodules:

```text
vendor/gpt5.6-reviewer/skills/code-review
vendor/pi-codex
```

The reviewer checkout is retained as a reference dependency, not a discovered skill; the shared reviewer supplies `code-review`. Initialize with `git submodule update --init --recursive`; never edit them directly. `bun run check:submodules` verifies gitlinks, origins, cleanliness, required assets, skill ownership, and the parent-owned Bun dependency boundary for `vendor/pi-codex`.

## MCP adapter and browser

The local adapter package source is:

```text
~/.pipi/agent/runtime/node_modules/pi-mcp-adapter
```

It replaces legacy registry-source settings during installation. Regular Pi's potentially secret-bearing MCP file is never copied.

Three lazy browser servers are installed: `browser-chrome-control`, `browser-chrome-headed`, and `browser-chrome-headless`. Their generated and direct installed invocation paths share the same recorded Bun and exact local `chrome-devtools-mcp@1.8.0` boundary. Across adapter `control-mcp.sh`, `mcp.sh`, and generated MCP entries, an unset `PIPI_BUN_RUNTIME` uses the recorded Bun and a set value must match it exactly; invalid values fail before server startup. Re-run the PiPi installer to regenerate managed wiring; do not run a shared skill's installer over PiPi MCP configuration. Use disposable headless mode for public/local checks. Use headed persistent mode only when current profile data is explicitly required. No install or test opens an authenticated profile automatically.

## Isolation and authentication

The launcher invokes the installed JavaScript entrypoint with its recorded absolute Bun executable and exports Pipi-only settings/session paths. Pipi auth remains separate unless `--share-auth` is explicitly requested; that option creates a symlink and refuses to overwrite existing auth state.

## Manual account switching

Pipi loads unchanged upstream `pi-multi-pass@1.5.1` from exactly one local isolated runtime package, never a registry source at startup. The reviewed upstream revision is `0d9a2113f26d38eb041f7b641d0f517520594872`; both Bun locks retain the reviewed npm tarball integrity. The package has no runtime dependencies or lifecycle scripts. Reinstallation replaces duplicate multi-pass sources (including their filters) while preserving unrelated package filters, settings, and auth. No pools, chains, presets, or `multi-pass.json` files are created or enabled by installation.

In Pipi:

1. `/subs add` — add an extra account for your provider.
2. `/login openai-codex-2` — authenticate the new Codex account in the browser (use the provider name shown by `/subs add`). Choose your second ChatGPT account; the existing `openai-codex` login remains separate. `/subs login` only guides you to the native `/login` command and can log out a selected existing extra account when re-authentication is confirmed.
3. `/subs switch` — select the account to use (or `/subs switch openai-codex-2`; switch back with `/subs switch openai-codex`).
4. `/subs limits` — inspect account limits.

This integration is for **manual switching only**. Upstream 1.5.1 has an automatic-failover bug; full automatic failover reliability is not claimed. Leave pools unconfigured. Existing user-authored configuration is not deleted or rewritten.

**Project configuration is trusted code:** upstream reads `.pi/multi-pass.json` without Pi's project-trust gate. It can enable automatic routing and execute configured selector scripts with full process privileges. Pipi does not patch this upstream behavior; review project configuration before opening untrusted repositories.

Switching affects the current Pi session, not Codex CLI authentication or explicit subagent model/provider defaults. Extra provider names do not inherit `openai-codex`-specific `models.json` overrides; configure those separately if needed. Login and limits may contact providers; the deterministic SDK smoke uses dummy auth and makes no network requests or paid model calls.

To repeat the smoke against the repository SDK (or a parent-selected installed SDK), run:

```sh
bun tests/scripts/fixtures/multi-pass-smoke.mjs
bun tests/scripts/fixtures/multi-pass-smoke.mjs --sdk-root /path/to/runtime/node_modules/@earendil-works/pi-coding-agent --package-root /path/to/runtime/node_modules/pi-multi-pass
```

Both invocations create and remove a disposable HOME; they never read the caller's auth.

## Updating

```sh
bun run check:pipi-changelog -- <version>
bun run update:pipi -- <version>
bun run complete:pipi-upgrade
```

The updater checks publication with `bun pm view`, updates aligned direct ranges and exact family overrides, regenerates `bun.lock`, validates the locked Pi family, and restores both files on failure.

## Development checks

```sh
bun install --frozen-lockfile
bun run check:bun-install
bun run check:pipi-version
bun run check:submodules
bun run test:deterministic
bun run test:browser
bun run check
bun run format:check
```

Tests use temporary HOME/cache/targets and do not access real Pipi auth. Live Claude/Codex backend tests require separate authorization.

The workflow sandbox is the sole Node runtime exception. Candidate Node executables must pass a real permission-mode capability probe before use. The sandbox retains permission flags, restricted filesystem access, authenticated IPC, VM code-generation denial, resource/request bounds, cancellation, signals, and forced cleanup. See [docs/bun-runtime.md](docs/bun-runtime.md).

## Uninstall and rollback

`bun run uninstall:pipi` removes only the managed launcher. Add `-- --purge` to remove all Pipi-owned state. Neither mode changes regular Pi files.

For source rollback, restore the previous manifests/locks/scripts and reinstall. For installation-only rollback, preserve `~/.pipi` settings/sessions and replace only managed launcher/runtime assets from a reviewed prior source revision. Pipi never changes the separately installed Bun prerequisite.
