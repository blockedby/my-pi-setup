/** All model-facing strings for the subagents tools. */

/** Describes background delegation, role defaults, and direct-agent capacity. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn an autonomous background subagent with its own context and normal host permissions. Choose a role profile independently of model: explore (read-only, GPT6 Luna default), implement (workspace changes, Sol6.1 default), or review (read-only, Sol6.1 default). Profiles default to Pi and accept model and reasoning_effort overrides; incompatible harness overrides are rejected. The parent chooses the model appropriate to the task: Sol6.1, GPT6 Luna, or GPT6 Astra rarely; ordinary custom models remain supported. Read-only roles use guidance and exclude explicit edit/write tools, not an OS sandbox. Without a profile, specify a harness and optionally its model/effort, or use harness defaults. Give a self-contained goal, scope, role, and expected output; a child can own a complete task including related tests and documentation. Children cannot orchestrate agents/workflows or ask the user. The main agent owns integration and final acceptance. Use trusted working directories. Returns immediately with an id; results arrive automatically as follow-ups. Direct Pi family quotas: Sol 4, Luna 16, Astra 4 (legacy IDs retained; Terra 8). Claude/Codex share a cap of 4; pipeline graphs do not use these quotas.";

export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Delegate a self-contained task to a background explore, implement, or review agent; choose model and effort independently";

export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Delegate when independent ownership helps. Supply a concise, self-contained goal, scope, role, and expected output; allow full-task ownership including related tests and documentation. Choose model and effort for the task, not a forced Luna-first escalation.",
  "Use explore or review for read-only work and implement for workspace changes. Coordinate overlapping ownership when running agents in parallel; the main agent integrates results and owns final acceptance.",
  "Ask for the next step and conclusion first, followed by evidence, changed paths where applicable, checks, and remaining risks. Do not authorize recursive delegation, user questions, credential changes, or unrequested Git delivery or external writes.",
  "After spawning, continue independent work or end the turn with the overall task pending. Results arrive automatically and trigger a parent turn; do not wait, sleep, or repeatedly poll for completion.",
];

export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Self-contained goal, scope, role, and expected output, with the context needed to own the assigned task independently.",
  name: "Short human-readable name for listings and the UI",
  profile:
    'Optional role: "explore" (read-only), "implement" (workspace changes), or "review" (read-only). Defaults to Pi; model and reasoning_effort are independently overridable.',
  harness:
    'Harness: "pi", "claude", or "codex". Required without a profile. Profiles support Pi only; incompatible overrides are rejected rather than dropping role semantics.',
  workingDir: "Trusted working directory (default: current working directory)",
  model:
    'Optional model override. Pi accepts "provider/model-id" or a model id, including custom models. Profile defaults: implement/review openai-codex/gpt-6.1-sol; explore openai-codex/gpt-6-luna. openai-codex/gpt-6-astra is available for rare task-appropriate use. Without a profile, Pi inherits the parent model; other harnesses interpret their native aliases/slugs.',
  reasoningEffort:
    "Optional effort override on the shared scale. Profiles supply defaults; without a profile use harness defaults (Pi inherits the parent level).",
};

/** Builds the subagent_spawn result that tells the parent model how to continue. */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  harness: string;
  modelLabel: string;
  cwd: string;
}) {
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}).\n` +
    `It runs in the background. Do not wait or poll for it. Its result will be delivered automatically as a follow-up and trigger a new parent turn.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until all listed subagents have settled, then return their final outputs. Prefer letting results arrive automatically; use this only when you need a result before continuing.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all subagents (running and finished) with their harness and status.";

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  return text;
}
