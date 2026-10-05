# Pipi

Pipi is a ready-to-use, isolated Pi workspace for serious coding tasks. It combines focused agents, audited pipelines, browser tools, background terminals, workflows, repository search, and a polished terminal UI without changing your regular `pi` installation.

## Why use it

- **Less context switching.** Search, implementation, review, browser debugging, and long-running commands stay in one coding environment.
- **Flexible delegation.** Work solo, choose a focused agent, or opt into a pipeline.
- **Safer automation.** Read-only exploration and review, scoped implementation, and explicit delivery permission keep authority narrow.
- **Clear progress.** `/pipelines` shows active stages, agents, attempts, and status at a glance.
- **Isolated setup.** Bun runtime wiring, settings, sessions, and authentication live under `~/.pipi`; regular Pi remains untouched.

## What is included

### Agents

The approved agent system separates roles from model choice:

| Role        | Best for                          | Default model |
| ----------- | --------------------------------- | ------------- |
| `explore`   | Read-only repository exploration  | GPT6 Luna     |
| `implement` | Scoped implementation and testing | Sol6.1        |
| `review`    | Independent read-only review      | Sol6.1        |

The orchestrating agent chooses a model for each task, with Astra used rarely and explicit overrides welcome. Pi, Claude Code, and Codex harnesses remain options. Delegation is optional; requests to work solo are respected.

### Pipelines

| Approved pipeline       | How it works                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `implementing-pipeline` | Study → implement → independent audits → repair in the same session. |
| `audit-pipeline`        | Independent read-only audits → one consolidated report.              |

These are the only pipelines approved for new launches. Legacy feature, plan, and small-feature pipelines are retired from new-launch guidance. Pipelines are opt-in, not a prerequisite for implementation or review.

**Runtime transition:** these roles and pipelines describe the approved modernization; older installations may still expose legacy names. Check availability before launching. See [agent system](docs/agent-system.md) for transition details.

When supported, start with `/pipelines:implementing-pipeline <task>` or `/pipelines:audit-pipeline <task>`. Run `/pipelines` to inspect progress or ask Pipi to cancel active runs. Implementation pipelines use a caller-prepared dedicated Git worktree to keep changes isolated.

### Everyday tools

- `rg` content search and `fd` file discovery
- background terminals for servers, watchers, and long builds
- multi-agent workflows for phased or parallel tasks
- Chrome DevTools control in disposable headless or persistent headed modes
- deterministic Codex-backed web search, fetching, patching, and bounded tasks
- Native Pi MCP support with built-in server management and tool discovery
- ask-user, copy-all, session summaries, and Git/model status UI
- GitHub Dark Default theme

### Skills

Pipi uses your shared browser, frontend-quality, and code-review skills without installing competing copies. See [shared skill setup](docs/shared-skills.md).

| Skill                  | Purpose                                         |
| ---------------------- | ----------------------------------------------- |
| `code-review`          | Evidence-driven initial and closure review      |
| `plan-gh-backlog`      | Validate and publish structured GitHub backlogs |
| `browser-chrome`       | Choose and control the appropriate Chrome mode  |
| `codex-tools`          | Search, fetch, patch, and delegate Codex tasks  |
| `background-terminals` | Run and monitor long-lived commands             |
| `subagents`            | Delegate focused work to child models           |

## Isolation and safety

Pipi installs beside regular Pi and requires a stable supported Bun 1.4+ command to be installed first; Pipi never downloads or replaces Bun. Root/extensions share one frozen Bun workspace lock; the isolated installed runtime has one exact deployment lock. Its settings, sessions, MCP configuration, and authentication directory remain under `~/.pipi`. It does not copy regular Pi secrets. Authentication sharing is opt-in. The capability-verified, permission-restricted workflow sandbox is the sole documented Node runtime exception because its security boundary must not be weakened.

The installer pins and validates the bundled review, backlog, and Codex-tool submodules. Exploration and review are read-only. Delegation does not authorize commits, pushes, deployments, or other external changes.

In [Herdr](https://github.com/herdrdev/herdr), Pipi shows background subagent and pipeline activity and highlights when a question needs your answer. See [Herdr integration](docs/herdr-pipi-integration.md) for setup and current limitations.

## Setup

See [SETUP.md](SETUP.md) for installation, updates, authentication, MCP configuration, and uninstall instructions.

## Notes

Pipeline runs are session-scoped and are not resumed after shutdown or reload.

For role boundaries, workspace preparation, and the approved modernization, see [Agent system](docs/agent-system.md). The [legacy pipeline design](docs/pipelines-v1-design.md) is a historical implementation reference, not current launch guidance.

Additional references:

- [Local setup record and pending steps](docs/pipi-setup-record.md)
- [Subagent graph](docs/subagents-explained.html)
- [Original subagent design reference](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/docs/design-plan.md)

![Pipi interface](assets/pi-setup.jpeg)
