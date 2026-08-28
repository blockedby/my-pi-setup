---
name: update-pipi
description: Use when the user asks to update Pipi to a new version.
---

# Update Pipi

From the repository root, run these commands in order:

```sh
bun run check:pipi-changelog -- <version>
bun run update:pipi -- <version>
bun run complete:pipi-upgrade
```

Inspect the first command's output before continuing. It fetches the coding-agent changelog with `curl` only for a minor or major upgrade and highlights a `Breaking Changes` section.
