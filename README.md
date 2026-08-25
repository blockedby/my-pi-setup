# Pipi: an isolated Pi setup

Pipi installs the creator's Pi extensions, skills, workflows, GitHub Dark Default theme, and a pinned Pi runtime beside regular `pi`. It keeps its runtime, settings, and sessions under `~/.pipi` without replacing or modifying regular Pi.

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
- the canonical `plan-gh-backlog` skill and CLI from its pinned submodule

## Agents

| Agent/profile    | Short purpose                              |
| ---------------- | ------------------------------------------ |
| Pi subagent      | General delegated Pi task                  |
| `luna-explore`   | Read-only exploration with Luna at max reasoning |
| `luna-worker`    | Scoped implementation and testing with Luna at max reasoning |
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
| `plan-gh-backlog`      | Validate, plan, and publish issue backlogs |

The code-review policy is loaded directly from the initialized `vendor/gpt5.6-reviewer/skills` submodule, while `plan-gh-backlog` is loaded from `vendor/plan-gh-backlog`. Each source is pinned by the parent repository, and no colliding host skill is kept. The installer validates both initialized sources but never fetches, advances, or globally installs their optional CLIs.

No extra web-search service key or environment file is required. Pipi does not copy regular Pi's secret-bearing MCP configuration. See [SETUP.md](SETUP.md) for installation, isolation, MCP setup, auth, and uninstall instructions.

## Prompt templates

| Template | Usage | Purpose |
| -------- | ----- | ------- |
| `solve-issue` | `/solve-issue <issue URL or description>` | Runs a staged workflow: parallel discovery, shared planning, disjoint Luna implementation, Sol integration, a readiness sweep for newly unblocked scoped work, conditional Terra audit, and verification. It never commits, pushes, or closes the issue. |

Additional documentation:

- [Complete local setup record and pending steps](docs/pipi-setup-record.md)
- [Black-and-white subagent graph](docs/subagents-explained.html)
- [Original subagent design plan used as a reference](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/docs/design-plan.md)

![Pi setup interface](assets/pi-setup.jpeg)
