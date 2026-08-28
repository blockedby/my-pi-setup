# Bun runtime and package-manager contract

Pipi uses stable **Bun 1.4.0 or newer** as both its authoritative JavaScript runtime and package manager. Prerelease versions are rejected even when their numeric components meet the minimum.

## Bun prerequisite

A stable supported `bun` command must be installed before Pipi is used. Pipi does not download, install, replace, or manage Bun. CachyOS and Arch users can run `sudo pacman -Syu bun`; other users should follow the [official Bun installation instructions](https://bun.sh/docs/installation).

The installer resolves an explicit `--bun` path, `PIPI_BUN_RUNTIME`, or `bun` from `PATH` and probes its version before acquiring the per-HOME install lock or creating managed state. Missing executables, versions below 1.4.0, and prerelease/build versions fail with a clear prerequisite error.

## Lock ownership

- Root `bun.lock`: root plus all nine `extensions/*` workspaces and the parent-owned dependency boundary for read-only `vendor/pi-codex`.
- `config/pipi-runtime/bun.lock`: the isolated deployment root copied to `~/.pipi/agent/runtime`.
- No root or extension `package-lock.json` is allowed. Per-extension Bun locks are also rejected.
- `vendor/pi-codex/package-lock.json` remains an immutable submodule source artifact. Pipi never executes it or another package manager to consume it.

The second Bun lock is necessary because the isolated installed runtime has a different exact manifest and lifecycle policy from the development workspace. Both roots install with `bun install --frozen-lockfile`. Missing or stale locks fail rather than regenerate during normal installation.

## Lifecycle and resolution policy

The root trusted dependency list is exactly:

- `@google/genai` — reviewed no-op preinstall required by the Pi dependency graph
- `protobufjs` — reviewed postinstall
- `msgpackr-extract` — reviewed native optional-package setup used by Effect's graph

The isolated runtime trusts only `@google/genai` and `protobufjs`. Defining these lists replaces Bun's broad built-in defaults.

All Effect extensions retain an explicit compiler preparation command. Root postinstall discovers the nine applicable workspaces and runs `effect-tsgo patch` sequentially through Bun. This sequencing prevents workspace lifecycle tasks within one install invocation from racing while patching the shared TypeScript 7.0.2 native compiler. It is not an inter-process lock for separate root preflights run concurrently against the same checkout; that unsupported same-checkout operation remains an impact-2 follow-up. A lock-hash marker prevents repeated unchanged installs from stacking backups. Verification requires every workspace's compiler to report `Version 7.0.2+effect-tsgo.0.24.3` and resolve the native platform compiler.

Direct Effect, TSGO, Claude SDK, TypeScript, formatter, Acorn, TypeBox, and vendor-boundary versions retain their pre-migration resolved values through exact declarations or root overrides. Bun's peer/hoist model may remove duplicate physical copies present in the old independent trees; the authoritative lock and checks preserve direct versions and required optional/native artifacts.

## Runtime classification

| Path | Authority | Contract |
| --- | --- | --- |
| Managed `pipi` launcher and Pi entrypoint | Bun | Launcher records and invokes the selected absolute stable Bun. |
| Repository scripts, formatter, TypeScript, tests, extension hosts | Bun | Script entries invoke Bun explicitly, including compiler and Effect patch entrypoints. |
| Root and extension dependency preparation | Bun package manager | One root workspace frozen install. |
| Isolated Pi, MCP adapter, and browser package | Bun package manager | Exact separate frozen deployment lock under Pipi-owned state. |
| Browser control and `chrome-devtools-mcp` | Bun | Vendored runtime seams receive Bun; the pinned installed browser entrypoint is invoked directly. |
| Workflow sandbox child | **Node security exception** | Genuine Node >=22.19.0 must pass the permission capability probe, then runs with restricted reads, authenticated IPC, VM code-generation denial, bounds, cancellation, and cleanup. |
| Git, shells, fd/rg, Chrome, Codex/Claude, platform process tools | Native executable boundaries | Not JavaScript runtime/package-manager exceptions. |
| Vendor submodules | Read-only boundary | Parent wiring supplies Bun dependencies; submodule files and gitlinks remain unchanged. |

## Node sandbox selection

An explicit `PIPI_NODE_RUNTIME` has precedence only when it is executable, stable/supported, and proves actual Node permission enforcement by allowing one file while denying an ungranted sibling with `ERR_ACCESS_DENIED`. A wrapper that only prints a supported version fails. Without an override, an old current-process Node does not mask a supported PATH Node. The resolver never substitutes Bun for the permission boundary.

## Browser

`chrome-devtools-mcp@1.8.0` is locked in the isolated runtime. Without changing the read-only vendor source, installation replaces the copied execution and documentation boundary with parent-owned scripts. Generated MCP, direct installed `control-mcp.sh` and `mcp.sh`, `install-local.sh`, README/reference instructions, and the package wrapper all record the same absolute Bun and exact local entrypoint. `PIPI_BUN_RUNTIME` may be unset on every installed entrypoint; when set, it must exactly equal the recorded absolute Bun or fail before server startup. Direct control additionally checks that the recorded executable still exists and reports the exact stable Bun version validated during installation. No installed path performs floating registry execution or package-manager fallback.

## Installation, locking, and rollback

Every normal install and reinstall creates a private isolated-runtime stage from `config/pipi-runtime/package.json` and `config/pipi-runtime/bun.lock`, runs `bun install --frozen-lockfile`, validates required Pi, adapter, and browser entrypoints, applies Pi branding, and activates the staged runtime through the managed installer transaction. Existing runtime contents are not trusted or reused. Browser asset target and rollback occupancy is checked with `lstat` semantics, so dangling managed symlinks are moved and restored as directory entries without following or mutating their external referents. `--skip-repository-dependencies` may omit only the root workspace install; isolated runtime staging remains mandatory.

The root frozen Bun workspace preparation is an explicit repository preflight/cache boundary. It runs before creation of the managed HOME transaction and may leave repaired repository `node_modules` or Bun package-cache state after a later managed-HOME failure. Those package-manager outputs are deliberately not snapshotted and no repository `node_modules` rollback is claimed. `bun install --frozen-lockfile` keeps tracked manifests and the authoritative root `bun.lock` unchanged, and preparation is idempotent/repairable: the next normal install reruns the preflight before attempting a new managed transaction.

The removed `--skip-dependencies` option is rejected during argument parsing, before Bun resolution, lock acquisition, HOME inspection, launcher handling, or runtime mutation, with guidance to run the normal frozen installation.

The per-HOME lock is an atomically created symlink carrying host, PID, boot identity, Linux process-start identity when available, and a random token. Live same-host ownership remains exclusive. Proven dead same-host or reboot/PID-reuse ownership is quarantined and recovered; foreign, malformed, or unverifiable ownership is preserved and refused. A malformed lock reports the exact manual recovery path rather than guessing. Recovery identity is exercised on Linux; hosts without `/proc` use the conservative PID fallback and remain an unexercised portability case.

Source rollback restores the prior reviewed manifests, locks, scripts, and docs, followed by reinstall. For installation, the previous complete managed agent tree and launcher remain available as backups while a private staged copy receives removals, runtime/browser assets, settings, models, MCP, Herdr, auth-link metadata, and launcher changes. Any caught failure through activation restores exact prior bytes, material modes, link targets, presence, and managed directory state; auth targets and dangling browser-link referents are never dereferenced for the snapshot or replacement. A dead-owner retry also removes only the stage named by its verified lock token. Abrupt host loss during the short multi-path activation window is not claimed to be a cross-filesystem atomic commit; its stale lock is recoverable, while any activation backup should be inspected before manual cleanup. The repository preflight/cache outputs and separately installed Bun prerequisite are outside Pipi's managed-HOME rollback boundary. Never mutate vendor locks or auth data during rollback.

Linux tests cover executable resolution, frozen root and isolated installation, managed-state rollback, lock recovery, repeat installation, and browser wiring. Non-Linux runtime execution and installer process-identity behavior, abrupt host loss during installer activation, authenticated browser profiles, and live model backends remain unverified. Browser tests are anonymous and disposable.
