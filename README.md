# Pipi: an isolated Pi setup

Pipi installs the creator's Pi extensions, skills, workflows, and GitHub Dark Default theme beside an existing `pi` command. It keeps its settings and sessions under `~/.pipi` and uses the existing Pi executable rather than replacing it.

Included resources:

- Codex, Claude, and Pi subagents, including Luna exploration and Terra audit profiles
- background terminals and workflows
- `fd` file discovery and `rg` content search
- summaries, Git/model status UI, ask-user, and copy-all tools
- the GitHub Dark Default theme
- deterministic Codex-backed search/fetch/task tools when sibling `../pi-codex` is present
- isolated MCP support through `pi-mcp-adapter` 2.15.0, matching the extension version observed in regular Pi
- the `browser-chrome` skill and control/headed/headless Chrome DevTools MCP servers from `pi-agent-setup`
- the canonical evidence-driven `code-review` skill from the pinned `gpt5.6-reviewer` submodule

## Agents

| Agent/profile    | Short purpose                              |
| ---------------- | ------------------------------------------ |
| Pi subagent      | General delegated Pi task                  |
| `luna-explore`   | Prompt-guided read-only exploration with Luna |
| `terra-audit`    | Prompt-guided read-only audit with Terra    |
| Claude subagent  | General delegated Claude task              |
| Codex subagent   | General delegated Codex task               |

## Skills

| Skill                  | Short purpose                              |
| ---------------------- | ------------------------------------------ |
| `subagents`            | Delegate work to child models              |
| `background-terminals` | Run and monitor background commands        |
| `code-review`          | Evidence-driven initial and closure review |
| `browser-chrome`       | Select and control a safe Chrome mode      |
| `codex-tools`          | Search, fetch, patch, and Codex tasks      |

The code-review policy is loaded directly from the initialized `vendor/gpt5.6-reviewer/skills` submodule, so Pipi has one canonical copy and no colliding host skill. The pinned source also includes the reviewer role, verifier prompt, schemas, examples, and optional dependency-free Python contract CLI; the Pipi installer does not fetch, advance, execute, or globally install that CLI.

No extra web-search service key or environment file is required. Pipi does not copy regular Pi's secret-bearing MCP configuration. See [SETUP.md](SETUP.md) for installation, isolation, MCP setup, auth, and uninstall instructions.

Additional documentation:

- [Complete local setup record and pending steps](docs/pipi-setup-record.md)
- [Black-and-white subagent graph](docs/subagents-explained.html)
- [Original subagent design plan used as a reference](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/docs/design-plan.md)

![Pi setup interface](assets/pi-setup.jpeg)
