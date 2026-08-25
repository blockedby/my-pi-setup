import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareWorkflowScript } from "./meta.ts";
import { runWorkflowSandbox } from "./sandbox.ts";

function solveIssueScript() {
  const template = readFileSync(
    new URL("../../prompts/solve-issue.md", import.meta.url),
    "utf8",
  );
  const opening = template.indexOf("```js\n");
  const closing = template.indexOf("\n```", opening + 6);
  if (opening < 0 || closing < 0)
    throw new Error("Missing workflow code block");
  return template.slice(opening + 6, closing);
}

test("solve-issue template executes discovery and implementation waves in parallel", async () => {
  const prepared = prepareWorkflowScript(solveIssueScript());
  assert.deepEqual(
    prepared.meta.phases.map((phase) => phase.title),
    ["Discover", "Plan", "Implement", "Integrate", "Audit", "Verify"],
  );

  const controller = new AbortController();
  const phases: string[] = [];
  const calls: Array<{ label: string; phase: string }> = [];
  const activeByPhase = new Map<string, number>();
  const peaks = new Map<string, number>();
  const result = await runWorkflowSandbox({
    source: prepared.source,
    args: { issue: "Example issue" },
    cwd: process.cwd(),
    signal: controller.signal,
    onPhase: (title) => phases.push(title),
    onAgent: async (_prompt, options) => {
      const label = String(options.label);
      const phase = String(options.phase);
      calls.push({ label, phase });
      const active = (activeByPhase.get(phase) ?? 0) + 1;
      activeByPhase.set(phase, active);
      peaks.set(phase, Math.max(peaks.get(phase) ?? 0, active));
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeByPhase.set(phase, active - 1);

      if (label === "plan") {
        return {
          ok: true,
          output: "plan complete",
          structured: {
            contract: "Example contract",
            sharedPaths: ["src/index.ts"],
            needsTerraAudit: true,
            auditReason: "Shared integration changes public exports.",
            tasks: [
              {
                id: "feature",
                objective: "Implement the feature",
                editPaths: ["src/feature.ts"],
                context: "Independent module",
                acceptance: "Focused feature test passes",
                nonGoals: "Do not change exports",
              },
              {
                id: "validation",
                objective: "Add validation",
                editPaths: ["src/validation.ts"],
                context: "Independent validator",
                acceptance: "Focused validation test passes",
                nonGoals: "Do not change the feature module",
              },
            ],
          },
        };
      }

      return { ok: true, output: `${label} complete` };
    },
  });

  assert.deepEqual(phases, [
    "Discover",
    "Plan",
    "Implement",
    "Integrate",
    "Audit",
    "Verify",
  ]);
  assert.equal(peaks.get("Discover"), 3);
  assert.equal(peaks.get("Implement"), 2);
  assert.deepEqual(
    calls
      .filter((call) => call.phase === "Implement")
      .map((call) => call.label),
    ["implement:feature", "implement:validation"],
  );
  assert.deepEqual(result, {
    issue: "Example issue",
    discovery: ["behavior complete", "acceptance complete", "impact complete"],
    plan: {
      contract: "Example contract",
      sharedPaths: ["src/index.ts"],
      needsTerraAudit: true,
      auditReason: "Shared integration changes public exports.",
      tasks: [
        {
          id: "feature",
          objective: "Implement the feature",
          editPaths: ["src/feature.ts"],
          context: "Independent module",
          acceptance: "Focused feature test passes",
          nonGoals: "Do not change exports",
        },
        {
          id: "validation",
          objective: "Add validation",
          editPaths: ["src/validation.ts"],
          context: "Independent validator",
          acceptance: "Focused validation test passes",
          nonGoals: "Do not change the feature module",
        },
      ],
    },
    implementations: [
      "implement:feature complete",
      "implement:validation complete",
    ],
    integration: "integrate complete",
    audit: "audit complete",
    verification: "verify complete",
  });
});
