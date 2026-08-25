---
description: Solve an issue through a staged parallel Luna workflow
argument-hint: "<issue URL or complete issue description>"
---

Solve this issue: $@

Use this workflow only when the issue has a genuine parallel discovery or implementation wave. If the work is ordered, dependency-heavy, or has shared mutable ownership, solve it directly in the main chat instead of serializing agents. Otherwise, the user explicitly requested a workflow: run the `workflow` tool with `args` set to a JSON-encoded **string** whose parsed value is `{"issue": "$@"}`, and use this script. Do not commit, push, open or close GitHub issues, or make external-state changes. The final workflow result is a handoff for the main agent, which owns user communication and any publication decision.

```js
export const meta = {
  name: "solve-issue",
  description: "Discover, plan, implement, integrate, and verify one issue with bounded parallel work.",
  phases: [
    { title: "Discover", detail: "Three independent read-only investigations run concurrently." },
    { title: "Plan", detail: "Create one shared contract and disjoint implementation scopes." },
    { title: "Implement", detail: "Run the planned non-overlapping Luna tasks in parallel." },
    { title: "Integrate", detail: "Apply shared wiring and inspect the combined workspace." },
    { title: "Unblock", detail: "Find and dispatch newly dependency-ready issue-scoped leaf work." },
    { title: "Audit", detail: "Use Terra when risk, cross-cutting impact, or disagreement warrants it." },
    { title: "Verify", detail: "Run focused acceptance checks and report residual risks." },
  ],
};

const LUNA = { model: "gpt-5.6-luna", provider: "openai-codex", effort: "max" };
const SOL = { model: "gpt-5.6-sol", provider: "openai-codex", effort: "high" };
const TERRA = { model: "gpt-5.6-terra", provider: "openai-codex", effort: "high" };
const issue = typeof args === "string" ? args : args?.issue;

if (typeof issue !== "string" || issue.trim() === "") {
  return { ok: false, error: "Provide an issue URL or complete issue description in args.issue." };
}

const PLAN = {
  type: "object",
  properties: {
    contract: { type: "string" },
    sharedPaths: { type: "array", items: { type: "string" } },
    needsTerraAudit: { type: "boolean" },
    auditReason: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          objective: { type: "string" },
          editPaths: { type: "array", items: { type: "string" } },
          context: { type: "string" },
          acceptance: { type: "string" },
          nonGoals: { type: "string" },
        },
        required: ["id", "objective", "editPaths", "context", "acceptance", "nonGoals"],
      },
    },
  },
  required: ["contract", "sharedPaths", "needsTerraAudit", "auditReason", "tasks"],
};
const NEXT_WAVE = {
  type: "object",
  properties: { tasks: PLAN.properties.tasks },
  required: ["tasks"],
};

phase("Discover");
const discovery = await parallel([
  () => agent(`Read-only investigation of issue:\n${issue}\n\nTrace the current behavior and likely root cause. Report exact paths, evidence, and unknowns. Do not edit.`, { label: "behavior", phase: "Discover", ...LUNA }),
  () => agent(`Read-only acceptance analysis for issue:\n${issue}\n\nFind existing tests, contracts, validators, and edge cases that define done. Report exact paths and acceptance checks. Do not edit.`, { label: "acceptance", phase: "Discover", ...LUNA }),
  () => agent(`Read-only impact analysis for issue:\n${issue}\n\nMap affected callers, public exports, registries, configuration, fixtures, and documentation. Report exact paths and dependencies. Do not edit.`, { label: "impact", phase: "Discover", ...LUNA }),
], { concurrency: 3 });

phase("Plan");
const planResult = await agent(
  `Plan a safe, fast implementation for issue:\n${issue}\n\nDiscovery results:\n${JSON.stringify(discovery)}\n\nReturn a shared contract, main-agent-owned shared paths, and at most four implementation tasks. Every task must have disjoint editPaths, one independently verifiable deliverable, a concrete acceptance check, and non-goals. Keep files that must change atomically in one task. Do not plan a task if its contract or ownership is unresolved. Set needsTerraAudit only for a high-risk claim, cross-cutting integration, or conflicting worker evidence, and explain the auditReason.`,
  { label: "plan", phase: "Plan", schema: PLAN, ...SOL },
);

const plan = planResult.ok && planResult.structured ? planResult.structured : undefined;
const normalizePath = (value) => {
  if (typeof value !== "string") return undefined;
  const path = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!path || path === "." || path.includes("*") || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return undefined;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  return path;
};
const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
const validatePlan = (candidate) => {
  if (!candidate || !Array.isArray(candidate.tasks) || !Array.isArray(candidate.sharedPaths)) {
    return { ok: false, error: "Planning did not return a complete shared contract and task list." };
  }
  const sharedPaths = candidate.sharedPaths.map(normalizePath);
  if (sharedPaths.some((path) => !path)) {
    return { ok: false, error: "Shared paths must be concrete paths without globs." };
  }
  const taskIds = new Set();
  const ownedPaths = [];
  for (const task of candidate.tasks.slice(0, 4)) {
    if (typeof task?.id !== "string" || !task.id || taskIds.has(task.id) || !Array.isArray(task.editPaths)) {
      return { ok: false, error: "Each implementation task needs a unique id and edit path list." };
    }
    taskIds.add(task.id);
    const editPaths = task.editPaths.map(normalizePath);
    if (editPaths.length === 0 || editPaths.some((path) => !path)) {
      return { ok: false, error: `Task ${task.id} must own concrete edit paths without globs.` };
    }
    for (const path of editPaths) {
      if (sharedPaths.some((shared) => overlaps(path, shared)) || ownedPaths.some((owned) => overlaps(path, owned.path))) {
        return { ok: false, error: `Task ${task.id} overlaps a shared or already-owned edit path: ${path}.` };
      }
      ownedPaths.push({ taskId: task.id, path });
    }
  }
  return { ok: true, tasks: candidate.tasks.slice(0, 4), sharedPaths };
};
const planValidation = validatePlan(plan);
const tasks = planValidation.ok ? planValidation.tasks : [];

phase("Implement");
const implementations = planValidation.ok ? await parallel(
  tasks.map((task) => () => agent(
    `Implement one bounded issue task.\n\nIssue: ${issue}\nShared contract: ${plan.contract}\nTask id: ${task.id}\nObjective: ${task.objective}\nYou may edit only: ${JSON.stringify(task.editPaths)}\nContext: ${task.context}\nAcceptance: ${task.acceptance}\nNon-goals: ${task.nonGoals}\n\nDo not edit shared paths ${JSON.stringify(plan.sharedPaths)}, commit, push, or make external-state changes. Run focused checks that do not mutate outside your owned paths. Report changed paths, checks, risks, and the next step.`,
    { label: `implement:${task.id}`, phase: "Implement", ...LUNA },
  )),
  { concurrency: 4 },
) : [];

phase("Integrate");
const integration = planValidation.ok ? await agent(
  `Integrate the planned issue solution.\n\nIssue: ${issue}\nShared contract: ${plan?.contract ?? "Planning failed; do not infer a contract."}\nMain-owned shared paths: ${JSON.stringify(plan?.sharedPaths ?? [])}\nWorker results: ${JSON.stringify(implementations)}\n\nInspect the workspace. Integrate only compatible completed work, resolve shared exports/registries/manifests if required, and do not commit or push. If planning or a required implementation task failed, preserve the evidence and report a blocker instead of guessing.`,
  { label: "integrate", phase: "Integrate", ...SOL },
) : { ok: false, error: planValidation.error };

phase("Unblock");
const readiness = planValidation.ok ? await agent(
  `Perform a read-only readiness sweep after integrating this issue:\n${issue}\n\nShared contract: ${plan.contract}\nMain-owned paths: ${JSON.stringify(planValidation.sharedPaths)}\nIntegration report: ${integration.ok ? integration.output : integration.error}\n\nInspect only the remaining work necessary to satisfy the original issue scope. Return zero to four newly dependency-ready, independent leaf tasks. Every task must have unique id, concrete non-overlapping edit paths outside main-owned paths, one objective, context, acceptance, and non-goals. Include adjacent work only when it is required by the original issue; do not expand scope. Return an empty task list when no genuine parallel wave remains. Do not edit.`,
  { label: "unblock", phase: "Unblock", schema: NEXT_WAVE, ...SOL },
) : { ok: false, error: planValidation.error };
const nextCandidate = readiness.ok && readiness.structured
  ? { tasks: readiness.structured.tasks, sharedPaths: planValidation.sharedPaths }
  : { tasks: [], sharedPaths: planValidation.ok ? planValidation.sharedPaths : [] };
const nextValidation = validatePlan(nextCandidate);
const followUps = planValidation.ok && nextValidation.ok ? await parallel(
  nextValidation.tasks.map((task) => () => agent(
    `Implement one newly unblocked issue task.\n\nIssue: ${issue}\nShared contract: ${plan.contract}\nTask id: ${task.id}\nObjective: ${task.objective}\nYou may edit only: ${JSON.stringify(task.editPaths)}\nContext: ${task.context}\nAcceptance: ${task.acceptance}\nNon-goals: ${task.nonGoals}\n\nThis task became ready after integration. Do not edit main-owned paths ${JSON.stringify(planValidation.sharedPaths)}, commit, push, or make external-state changes. Run focused checks and report changed paths, checks, risks, and the next step.`,
    { label: `follow-up:${task.id}`, phase: "Unblock", ...LUNA },
  )),
  { concurrency: 4 },
) : [];

phase("Audit");
const audit = planValidation.ok && plan?.needsTerraAudit
  ? await agent(
      `Perform a read-only Terra audit of the integrated issue solution.\n\nIssue: ${issue}\nContract: ${plan.contract}\nAudit reason: ${plan.auditReason}\nIntegration report: ${integration.ok ? integration.output : integration.error}\n\nInspect the combined workspace and diff. Verify the concrete high-risk, cross-cutting, or disputed concern; report evidence, impact, and blockers. Do not edit, commit, push, or close the issue.`,
      { label: "audit", phase: "Audit", ...TERRA },
    )
  : { ok: true, output: "Terra audit skipped: no high-risk, cross-cutting, or disputed concern." };

phase("Verify");
const verification = planValidation.ok ? await agent(
  `Verify the current workspace against this issue:\n${issue}\n\nContract: ${plan?.contract ?? "unavailable"}\nIntegration report: ${integration.ok ? integration.output : integration.error}\nTerra audit: ${audit.ok ? audit.output : audit.error}\n\nRun the narrowest relevant checks, inspect the combined diff, and report pass/fail, exact commands, unmet acceptance criteria, and residual risks. Do not edit, commit, push, or close the issue.`,
  { label: "verify", phase: "Verify", ...SOL },
) : { ok: false, error: planValidation.error };

return {
  issue,
  discovery: discovery.map((result) => result.ok ? result.output : result.error),
  plan: planResult.ok ? planResult.structured : planResult.error,
  planningBlocker: planValidation.ok ? null : planValidation.error,
  implementations: implementations.map((result) => result.ok ? result.output : result.error),
  integration: integration.ok ? integration.output : integration.error,
  readiness: readiness.ok ? readiness.structured ?? readiness.output : readiness.error,
  readinessBlocker: nextValidation.ok ? null : nextValidation.error,
  followUps: followUps.map((result) => result.ok ? result.output : result.error),
  audit: audit.ok ? audit.output : audit.error,
  verification: verification.ok ? verification.output : verification.error,
};
```
