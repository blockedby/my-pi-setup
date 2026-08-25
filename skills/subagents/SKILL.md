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
**Best default:** Pi is the general subagent harness, not the routine-routing default. For routine independent work, use `luna-explore` or `luna-worker`; use bare Pi only when deliberately choosing inherited-model behavior. It inherits the parent model and thinking level when `model` or `reasoning_effort` is omitted.

### Luna-First Rule

Optimize for wall-clock speed. For nontrivial work with two or more dependency-ready, independent scopes, split it and launch one Luna per scope in the same parallel wave before broad sequential Sol exploration or planning. If work cannot form a genuine parallel wave because it is ordered, dependency-heavy, or shares mutable ownership, keep it in the main chat rather than serializing it through subagents. Work locally only for a trivial lookup, a shared decision or overlapping write ownership, or when delegation would add more latency than it saves.

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

### Swarm orchestration

Before a multi-Luna wave, make a lightweight manifest: scope name/id, prerequisites, exclusive edit ownership (shared read context is allowed), and acceptance check. Give every worker one objective, expected concise output/evidence, explicit non-goals, and a completion condition. Require a conclusion and recommended next step first. Start every dependency-ready scope in the same wave; never serialize independent Luna work. The direct Luna quota is 16, not a target: choose the number of genuinely independent scopes that reduces wall-clock time.

Treat automatic results as dependency events, not a batch barrier. Continue unrelated shared work and do not integrate on the first arrival. For each downstream decision, use only the required reports after they arrive; use one status check only when that gate needs it. Launch a follow-up only for a concrete unblocked gap or failed scope. Inspect claimed paths and validation before depending on a result. For an error or blocker, resolve its prerequisite or launch one narrower replacement with the missing input; never blindly retry or duplicate active/completed work unless adversarial comparison is intentional. Stop the wave once its declared objectives are covered. Use `terra-audit` in a later parent turn only for an integrated change, high-risk claim, or conflicting conclusions. Keep cross-cutting integration and final acceptance with the Sol/main agent.

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
