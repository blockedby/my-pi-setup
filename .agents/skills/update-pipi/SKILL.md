---
name: update-pipi
description: Use when the user asks to update Pipi to a new version.
---

# Update Pipi

From the repository root, run these commands in order:

```sh
npm run check:pipi-changelog -- <version>
npm run update:pipi -- <version>
npm run complete:pipi-upgrade
```

Inspect the first command's output before continuing. It fetches the coding-agent changelog with `curl` only for a minor or major upgrade and highlights a `Breaking Changes` section.
