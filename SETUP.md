# Pipi setup

Pipi is a side-by-side launcher for the existing Pi CLI. It does not replace `pi` or write to regular Pi's settings.

## Requirements

- Node.js and npm
- an existing `pi` executable in `PATH`
- `codex` in `PATH` for Codex subagents and Codex-backed tools
- optional sibling checkout `../pi-codex` (`pi-codex-tools`)

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

It loads this checkout as a local Pi package and adds sibling `../pi-codex` when that directory contains the `pi-codex-tools` package. It also seeds missing `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` values from regular Pi settings while leaving the regular settings file unchanged. Existing unrelated Pipi settings and package entries are preserved.

Add `~/.local/bin` to `PATH` if necessary, then verify the launcher:

```sh
pipi --version
```

Re-running the installer is safe and idempotent. For an already prepared development checkout, `--skip-dependencies` skips the lockfile installs:

```sh
npm run install:pipi -- --skip-dependencies
```

Custom executable and package locations are supported:

```sh
npm run install:pipi -- --pi /path/to/pi --codex-tools /path/to/pi-codex
```

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
npm test
```

Installer tests use temporary home directories and fake `pi`/`codex` executables; they never write to the real user configuration.
