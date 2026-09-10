# Herdr activity in Pipi

Pipi reports one status for its terminal pane:

- **Blocked** while an interactive prompt is waiting for an answer (including `ask_user`).
- **Working** while the root agent, a direct subagent, or a pipeline is active.
- **Idle** when neither work nor a prompt remains.

Answering or dismissing a prompt restores the aggregate status, not necessarily idle. Headless child sessions do not create panes or report the parent's state.

## Installation and ownership

The repository package supplies `extensions/herdr-pipi/index.ts`. The Pipi installer removes the old, Herdr-managed `~/.pipi/agent/extensions/herdr-agent-state.ts` within its rollback transaction. An unrecognized file at that location causes installation to fail rather than deleting custom code. The regular Pi profile is not changed.

Do not reinstall the official standalone Pi reporter into Pipi's extension directory: two reporters would compete for the same pane. Installation verification rejects that conflict. The bridge can be installed without the Herdr CLI; reporting only becomes active in a Herdr TUI pane with the required environment.

## Architecture

The existing subagent and pipeline status subscriptions publish authoritative active-ID snapshots through the Pi event bus. The bridge aggregates those snapshots with root lifecycle and generic `ui_prompt_start` / `ui_prompt_end` events. Activity is session-local; controller concurrency, execution, and delivery behavior are unchanged.

Herdr transport retains the existing `pi` agent identity, `herdr:pi` source, session references and monotonic report sequences. This is status integration, not a new Herdr agent kind.

## Deferred work and live verification

This change does **not** update Herdr, install the changed Pipi runtime, or fix Herdr restoring sessions through the regular `pi` executable. Configurable Pipi resume commands remain a separate Herdr task; do not globally alias `pi` to `pipi` as a workaround.

After an explicitly authorized installation and Pipi reload, verify in a disposable Herdr pane:

1. Root work sets working.
2. A background subagent or pipeline keeps working after the root turn settles.
3. `ask_user` shows blocked until answered or dismissed, including during background work.
4. Completion or cancellation of all work restores idle.
5. A headless child does not overwrite pane state.

Automated contract tests do not substitute for this visual/live check. No live installation or Herdr restart is part of the source implementation.
