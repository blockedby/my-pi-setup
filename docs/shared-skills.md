# Shared skills and PiPi ownership

PiPi consumes `browser-chrome`, `frontend-quality`, and `code-review` through the shared discovery directory `~/.agents/skills`. These skills are user-owned prerequisites, not private PiPi copies. Existing symlinks into development checkouts remain user-owned: installation must not replace the links or write into their targets.

PiPi-specific skills remain package resources. `plan-gh-backlog` remains a pinned package resource. The pinned reviewer submodule remains a read-only reference dependency, but is not exposed as a second `code-review` skill.

## Installing shared prerequisites

Choose reviewed upstream skill content before installing. Each shared skill directory must include `SKILL.md` and its referenced supporting files. A developer can link a reviewed local checkout into `~/.agents/skills/<name>`; the checkout location is their choice, not a portable PiPi default. Do not overwrite an occupied destination to create that link.

[skills.sh](https://www.skills.sh/docs/cli) provides a standard distribution CLI. Its [upstream documentation](https://github.com/vercel-labs/skills) describes global installation, named skill selection, and symlink versus copy installation. This is distinct from browser runtime provisioning. The documented Pi global target is `~/.pi/agent/skills`, not PiPi's isolated directory; the universal global target can also differ from `~/.agents/skills`. Do not assume an arbitrary `skills add --global` command produces the intended discovery layout. Inspect the selected CLI version's destinations in a disposable HOME before applying it to a real installation. Avoid `--all` or copy-to-every-agent installation as a collision remedy.

PiPi must not run a shared skill update over an existing development symlink. Updating shared repositories and accepting their content changes remain the owner's responsibility. Shared skill versions can affect other agents that consume the same directory.

## Discovery and collisions

Pi discovers skills from its configured agent directory, shared global skills, trusted project skill roots, package declarations, explicit settings paths, and CLI paths. Skill names—not directory names alone—determine collisions. Package identity deduplication does not reconcile different skill implementations with the same name.

Inspect logical paths, resolved link targets, names, and contents before migrating. Identical content does not by itself prove PiPi ownership. Differing copies must be retained for recovery; timestamps are not an authority rule. Unknown or customized conflicting entries require explicit resolution rather than silent removal.

A missing explicit settings path is configuration drift, not necessarily a duplicate. In particular, the previously configured `pi-agent-setup/skills/explanatory-html-pages` path should be reported separately. Remove or repair only the specific confirmed stale entry; preserve unrelated settings.

## Browser boundary

Skill discovery and browser execution are separate responsibilities. PiPi's runtime integration belongs outside discovered skill directories. It must preserve the three MCP server names (`browser-chrome-control`, `browser-chrome-headed`, `browser-chrome-headless`), pinned executable/dependency boundaries, and compatible tool contracts.

Moving commands is not proof of compatibility: shared browser launchers can have different Node/npm requirements and reject legacy overrides. Verify entrypoints, environment handling, tool schemas, control-first behavior, headed ownership, and disposable headless cleanup before retiring the legacy skill directory. Do not patch shared repositories to force compatibility.

## Migration safety

Repository changes do not migrate an existing installation automatically. Test using disposable HOME fixtures first. Live adoption must preserve affected configurations and displaced skill entries in durable backups outside discovery roots, without following shared symlinks or copying authentication data.

Symlinked managed `settings.json` or `mcp.json` files are refused before mutation, including dangling links. Explicitly resolve that ownership boundary before installation; PiPi must not write through the link or silently detach it from a user-managed configuration.

Migrate browser commands and their runtime together before retiring their former location. If validation or activation fails, restore the previous executable paths, configuration, link metadata, and presence/absence state. Preserve unrelated MCP entries, settings, and skills. Reinstallation must not recreate retired skill copies.

The explicit adoption command is `bun run install:pipi -- --adopt-shared-skills`. It is a full installer invocation, not a runtime-preserving patch command: use it only from the intended runtime revision. Do not run an older task checkout over a separately upgraded live installation.

Adoption retains displaced entries under `~/.pipi/agent/backups/shared-skill-migration-v1/<skill-name>`. The `configuration/` directory stores original `settings.json` and `mcp.json` entries without dereferencing symlinks, plus `absence.json` recording originally absent files. A repeated install without new conflicting copies leaves those backups intact. If another copy appears later, an occupied backup destination blocks adoption rather than overwriting the first backup.

For manual rollback, stop PiPi and its MCP processes first. Preserve the current configuration separately. Review the backup and restore the displaced entries to their original `~/.pipi/agent/skills/<skill-name>` paths, retaining link targets and permissions. Restore the saved configuration entries; remove an entry only when `absence.json` records that it was originally absent and you have accounted for subsequent edits. The restored browser MCP commands must point to the restored browser scripts. Repository package exposure and host-guidance changes are separate from installed backups: restore the matching reviewed source revision if rolling back the whole ownership change. Do not overwrite configuration edited since migration without reconciling those changes.

Do not touch browser profiles or account data. After a successful live migration, restart PiPi and reconnect its MCP servers so cached discovery and processes use the new configuration. Retain backups until the migrated installation has been verified; do not imply multi-path filesystem activation is crash-atomic.
