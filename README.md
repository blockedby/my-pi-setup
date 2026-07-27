# Pipi: an isolated Pi setup

Pipi installs the creator's Pi extensions, skills, workflows, and GitHub Dark Default theme beside an existing `pi` command. It keeps its settings and sessions under `~/.pipi` and uses the existing Pi executable rather than replacing it.

Included resources:

- Codex, Claude, and Pi subagents
- background terminals and workflows
- `fd` file discovery and `rg` content search
- summaries, Git/model status UI, ask-user, and copy-all tools
- the GitHub Dark Default theme
- deterministic Codex-backed search/fetch/task tools when sibling `../pi-codex` is present
- isolated MCP support through `pi-mcp-adapter` 2.15.0, matching the extension version observed in regular Pi

No extra web-search service key or environment file is required. Pipi does not copy regular Pi's secret-bearing MCP configuration. See [SETUP.md](SETUP.md) for installation, isolation, MCP setup, auth, and uninstall instructions.

Additional documentation:

- [Complete local setup record and pending steps](docs/pipi-setup-record.md)
- [Black-and-white subagent graph](docs/subagents-explained.html)

![Pi setup interface](assets/pi-setup.jpeg)
