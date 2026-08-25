---
name: subagents
description: invoke this skill when the user asks you to use subagents
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Truncated-result advisory

When a completed tool result explicitly reports truncation metadata, the parent may receive one passive advisory per run. If it appears, consider `subagent_spawn` with `profile: "luna-explore"` and a self-contained prompt; do not wait or poll for it. The advisory never blocks the current tool, auto-spawns, sends a message, or creates another turn. Child sessions bypass it naturally because `subagent_spawn` is unavailable there.

## Pi Harness

**Harness:** `pi`
**Prompt nicknames:** “pi”, “pi agent”, “pi subagent”
**Best default:** Use when the user does not request another harness. It inherits the parent model and thinking level when `model` or `reasoning_effort` is omitted.

### Luna-First Rule

Default routine, independent work to Luna before using Sol directly:

- `luna-explore` is a read-only profile for:
  - routine independent exploration
  - clarifying code patterns
  - reading and analyzing large files, logs, traces, and diffs
  - identifying candidate approaches
- `luna-worker` is a mutable profile for:
  - focused implementation and alternative implementations
  - documenting purpose
  - reproducing bugs and running tool chains
  - debugging
  - test generation and test execution
  - mechanical refactors
  - comparing candidate solutions

It is safe to run up to eight genuinely independent Luna workers in parallel. Their results arrive as automatic follow-ups in a later parent turn. Then launch `terra-audit` with the workers' conclusion-first reports to verify or compare them. Keep cross-cutting integration and final acceptance with the Sol/main agent.

Pi can use any model shown by `pi --list-models`. Prefer `provider/model-id`; a bare model id only works when unambiguous. Common picks in this environment:

| Model                            | Recommended effort |
| -------------------------------- | ------------------ |
| inherited parent model (default) | inherited          |
| `openai-codex/gpt-5.6-sol`       | `high`             |
| `openai-codex/gpt-5.6-terra`     | `high`             |
| `openai-codex/gpt-5.6-luna`      | `max`             |
| `opencode/claude-fable-5`        | `medium`           |

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. These map directly to pi thinking levels.

## Claude Code Harness

**Harness:** `claude`
**Prompt nicknames:** “claude”, “Claude Code”, “claude agent”, “claude subagent”, "cc"
**Best default:** use the latest fable model on high reasoning. Do not default to anything else, if the user does not specify, use fable.

| Model hint | Model               | Recommended effort |
| ---------- | ------------------- | ------------------ |
| `fable`    | latest Claude Fable | `high`             |

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. The extension maps these to Claude thinking-token budgets: 0, 1,024, 4,096, 10,000, 16,000, 32,000, and 63,999 tokens respectively.

Requires Claude Code to be installed and authenticated.

## Codex Harness

**Harness:** `codex`
**Prompt nicknames:** “codex”, “Codex CLI”, “codex agent”, “codex subagent”
**Best default:** `gpt-5.6-sol` with `high` effort for coding work. Do not use anything other than sol unless the user specifically asks for it.

| Model           | Recommended effort |
| --------------- | ------------------ |
| `gpt-5.6-sol`   | `high`             |
| `gpt-5.6-terra` | `high`             |
| `gpt-5.6-luna`  | `high`             |

**Thinking budgets accepted by the extension:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Codex maps these to the nearest effort supported by the selected model; `off`/`minimal` become `minimal`, while `max` becomes the highest extension-supported Codex effort.

Requires the Codex CLI to be installed and authenticated.

## Spawn and Manage

Call `subagent_spawn` with a complete `prompt`, short `name`, and either an explicit `harness` or a profile. A profile call supplies only `profile`, `prompt`, and `name` (plus optional `working_dir`); `luna-explore` fixes Pi/Luna/max reasoning and is read-only, `luna-worker` fixes Pi/Luna/max reasoning and may make scoped workspace changes, and `terra-audit` fixes Pi/Terra/high reasoning and is read-only. Profile children retain normal child tools, with only recursive orchestration and user-interaction tools excluded. Explicit profile conflicts are rejected. Direct Pi quotas are Sol=4, Terra=8, Luna=16; Claude and Codex share an aggregate cap of 4.

- `subagent_check({ id })`: inspect progress once when it is useful; never poll.
- `subagent_list()`: inspect all runs once when their status is useful; never poll.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

After spawning, continue useful independent parent work. If none remains, end the current turn and leave the overall task pending. The subagent result is delivered automatically as a follow-up and triggers a new parent turn.

Do not wait or poll for subagents. Do not use `sleep`, repeated checks/lists, or any other blocking command just to wait for completion.
