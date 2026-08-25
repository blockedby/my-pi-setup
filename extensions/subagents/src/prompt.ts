/** All model-facing strings for the subagents tools. */

/** Describes subagent_spawn, including harnesses and the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent: a fully autonomous, headless agent with its own context window and the selected harness's normal host permissions. Use profile luna-explore for broad routine independent read-only exploration, luna-worker for focused implementation, testing, and mechanical refactors, terra-audit for deeper audits and verification, and the Sol/main agent for cross-cutting integration and final acceptance. Profiles fix Pi, the exact model, and reasoning level; omit conflicting harness/model/reasoning_effort values. luna-explore and terra-audit have read-only role prompts, while luna-worker is authorized for scoped workspace changes. Without a profile, choose an explicit harness and preserve its normal model inheritance. Fire-and-forget: this returns immediately with an id. When the subagent settles, its final output is automatically delivered as a follow-up message that triggers a new parent turn. Do not wait or poll for subagent completion. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Only use trusted working directories. Pi quotas are Sol 4, Terra 8, and Luna 16; Claude and Codex share an aggregate cap of 4.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background subagent on a chosen harness or Luna/Terra profile (own context, normal tools) for a self-contained task";

/** Guides the parent model to delegate standalone tasks without blocking for results. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Optimize for wall-clock speed: default to Luna-first delegation for nontrivial work with two or more dependency-ready, independent scopes. Before broad sequential exploration or planning, split that work and spawn one self-contained Luna profile per scope in the same parallel wave. For routine independent work, select luna-explore or luna-worker rather than bare Pi/inherited Sol. If work cannot form a genuine parallel wave because it is ordered, dependency-heavy, or shares mutable ownership, keep it in the main chat rather than serializing it through subagents. Keep work local only when it is a trivial lookup, scopes depend on a shared decision or overlapping write ownership, or delegation would add more latency than it saves.",
  'After a tool result explicitly reports truncation, consider delegating a self-contained follow-up with subagent_spawn using profile "luna-explore"; do not wait or poll for it.',
  "Use profile luna-explore for broad/routine independent read-only exploration, luna-worker for focused implementation, test execution, and mechanical refactors, and terra-audit for deeper audits/verification.",
  "Before delegating multi-part work to Luna, split it into independently completable scopes. Give each Luna exactly one bounded question or deliverable, an explicit list of files it may edit—or a minimal inspection scope for read-only work—and explicit non-goals. A Luna may inspect dependencies for context but must not edit files outside its assigned edit scope. Treat schemas/contracts, validators, fixtures/tests, and documentation as separate scopes unless they must change together to produce one independently verifiable result.",
  "For Luna implementation tasks, include a compact pseudocode sketch of the desired module contract: inputs, outputs, key functions/types, expected behavior, and non-goals. Example: for a new feature, use separate Lunas for the isolated feature module, schema/types, validation, fixtures/tests, and documentation; keep shared exports and final wiring with the main agent.",
  "Orchestrate each Luna wave with a lightweight manifest: scope name/id, prerequisites, exclusive edit scope (shared read context is allowed), and acceptance check. Give every worker prompt one objective, expected concise output/evidence, explicit non-goals, and a completion condition; require its report to begin with conclusion and recommended next step. Launch all ready scopes in the same wave; do not serialize independent Luna work or make the parent repeat broad exploration that a Luna wave can perform concurrently. Keep shared contracts, central registries and manifests, integration files, overlapping edits, conflict resolution, and result integration with the main agent. Keep cross-cutting integration and final acceptance with the Sol/main agent.",
  "Treat automatic Luna results as dependency events, not a batch barrier: continue unrelated shared work and do not integrate on the first arrival. For each downstream decision, use only the required reports after they arrive; use one status check only when that gate needs it. Spawn a follow-up only for a concrete unblocked gap or failed scope. Inspect claimed paths and validation before depending on a result. For an error or blocker, resolve its prerequisite or launch one narrower replacement with the missing input; do not blindly retry or duplicate an active/completed scope unless adversarial comparison is intentional. Stop the wave when its declared objectives are covered.",
  "Use terra-audit in a later parent turn when the integrated change, a high-risk claim, or conflicting Luna conclusions need deep verification; ask workers to put their conclusion and recommended next step first so it survives output truncation.",
  "After subagent_spawn, continue useful independent work. If none remains, end the current turn and leave the overall task pending. The subagent result will be delivered automatically and trigger a follow-up parent turn.",
  "Do not wait or poll for subagents. Do not use sleep, repeated subagent_check/subagent_list calls, or any other blocking command just to wait for completion.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  profile:
    'Optional capability profile: "luna-explore", "luna-worker", or "terra-audit". With a profile, provide profile, prompt, and name; it fixes Pi, model, and reasoning. luna-explore and terra-audit use read-only system guidance; luna-worker permits scoped workspace changes.',
  harness:
    'Harness to run the subagent on: "pi", "claude", or "codex". Required without a profile and conflicting with profiles.',
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  model:
    'Model hint, interpreted by the chosen harness (pi: "provider/model-id" or model id; claude: model alias like "sonnet"/"opus"; codex: model slug). Omit for the harness default (pi inherits the current model).',
  reasoningEffort:
    "Reasoning effort on a shared scale; the harness maps it to its nearest native equivalent (pi thinking level, codex reasoning effort, claude thinking budget). Omit for the harness default (pi inherits the current level).",
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
