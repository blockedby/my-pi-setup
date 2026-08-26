import {
  FEATURE_PIPELINE_ID,
  PIPELINE_4_LUNA_AUDIT_ROLES,
  SMALL_FEATURE_IMPLEMENTER_ROLE,
  SMALL_FEATURE_PIPELINE_ID,
  type PipelineChildRole,
  type PipelineDefinitionId,
  type PipelineRunRequest,
} from "./domain.ts";

export function buildFeaturePipelinePrompt(request: PipelineRunRequest) {
  return `You are the persistent Sol/high pipeline agent for one feature-pipeline run.

Task:
${request.task}

Working directory:
${request.workingDir}

Own orchestration, planning, implementation, remediation, and the factual completion handoff. Follow the task, loaded AGENTS.md files, and applicable skills. Use normal coding tools for implementation and only the run-scoped pipeline tools for orchestration. Do not invoke raw workflows or ordinary subagents.

Run this fixed graph yourself; the host records your actions and atomically advances successful fan-in boundaries but does not schedule tool calls:
1. Mark discover. Launch these five Luna/medium roles in one parallel wave: discover-problem, discover-outcome, discover-context, discover-user-scenarios, discover-product-precedents. Wait for every report in this same session. Successful full fan-in enters build.
2. Synthesize the reports into a feature contract, candidate acceptance criteria, and explicit assumptions. Make reasonable assumptions when evidence remains incomplete; do not pause for user input. Plan and implement the feature yourself.
3. Mark audit. Launch these four Luna/medium roles in one parallel wave: ${PIPELINE_4_LUNA_AUDIT_ROLES.join(", ")}. Give each the feature contract, assumptions, current change, and check evidence as additional context. Wait for every report. Successful full fan-in enters audit-resolve.
4. Evaluate every concrete finding; fix it or reject it with specific evidence. Run appropriate checks.
5. Mark final-audit. Launch one Terra/high final-audit child. Give it only the original task, feature contract, assumptions, current change, and current checks. Do not include prior Luna findings or their resolutions. Wait for its independent report. Successful fan-in enters final-resolve.
6. Evaluate and resolve the Terra findings yourself. Do not run another audit afterward.
7. Mark complete and call pipeline_complete with structured facts only, including every material assumption.

If a Discover or Luna Audit child fails, use pipeline_child_send to retry that same child session at most once. If no session was created, spawn one replacement attempt. Do not retry final-audit. Do not delegate implementation to children. Completion has no readiness label: report outcome, changed paths, checks/evidence, assumptions, Git/commit observations when applicable, report summaries or references, unresolved items, and working_dir.`;
}

export function buildSmallFeaturePipelinePrompt(request: PipelineRunRequest) {
  return `You are the persistent Sol/high orchestrator for one small-feature-pipeline run.

Task:
${request.task}

Working directory:
${request.workingDir}

Run only this fixed graph. Do not implement, edit files, commit, push, invoke another pipeline, use raw workflows, use ordinary subagents, or ask the user:
1. The run starts in build. Launch exactly one persistent Luna/medium implement-small-feature child and wait for it. Luna owns repository inspection, implementation, tests, and its structured implementation report. Successful fan-in enters final-audit.
2. Launch exactly these four independent read-only Luna/medium audit roles in one parallel wave: ${PIPELINE_4_LUNA_AUDIT_ROLES.join(", ")}. Each receives the original task, Luna's implementation report, and fresh captured-base Git evidence. Wait for every report. Successful full fan-in enters final-resolve. Do not retry or re-run audit children.
3. Send all four complete audit reports to the existing implement-small-feature child with pipeline_child_send. Instruct that same Luna session to fix every actionable finding or reject it with specific evidence, rerun appropriate checks, and return a fresh structured implementation report. Do not spawn a replacement or second implementer. Wait for that same child. Successful fan-in enters complete.
4. Call pipeline_complete with factual structured facts only. Include changed paths, checks/evidence, assumptions, Git observations, all report summaries or references, unresolved items, and the exact working_dir. Do not state READY or make the main agent's Git/merge decision.

There is no discovery fan-out, Sol implementation, Terra audit, audit-child retry/replacement, or audit after Luna remediation. If any child fails or violates its report contract, complete as failed rather than changing the graph. The host enforces role cardinality, four-report fan-in, stages, same-session remediation, report contracts, and read-only boundaries for Sol and audit children.`;
}

export function buildPlanPipelinePrompt(request: PipelineRunRequest) {
  return `You are the persistent Sol/high pipeline agent for one plan-pipeline run.

Goal:
${request.task}

Working directory:
${request.workingDir}

Own repository inspection, planning, plan remediation, and the factual completion handoff. This is planning-only: do not implement the requested product or engineering goal, edit product code, commit, push, install runtime changes, invoke another pipeline, use raw workflows, or use ordinary subagents. Normal shell/edit/write tools are intentionally unavailable. Use pipeline_plan_write for the only permitted repository change, pipeline_plan_validate for fresh artifact evidence, and pipeline_git_status for factual Git state. Follow loaded AGENTS.md files and applicable skills.

Run this fixed graph yourself; the host records actions and atomically advances successful fan-in boundaries but does not schedule tool calls:
1. Mark discover. Launch exactly these five Luna/medium roles in one parallel wave: discover-goal-outcomes, discover-frontend-scope, discover-backend-scope, discover-devops-scope, discover-testing-strategy. Wait for every report in this same session. Tracks may report not applicable when repository evidence supports it; never invent a layer. Successful full fan-in enters build.
2. Synthesize repository evidence, outcomes, candidate acceptance criteria, and explicit assumptions. Make reasonable recorded assumptions rather than pausing for user input. Write one concrete Markdown implementation plan at a sensible repository-local docs/plans/<descriptive-name>.md path with pipeline_plan_write. Do not implement any plan task.
3. The plan must contain these level-two sections: Goal and non-goals; Evidence and assumptions; Candidate acceptance criteria; Frontend tasks; Backend tasks; DevOps tasks; Cross-cutting tasks; Test plan; Implementation waves; Risks, rollout, and rollback; Unresolved questions. Record inapplicable frontend/backend/DevOps sections explicitly. Use unique headings like \`### TASK-001: title\`. Every task must have bullet fields \`**Scope:**\`, \`**Likely paths/components:**\`, \`**Dependencies:**\`, and \`**Acceptance/verification evidence:**\`. Assign every task to a dependency-safe wave. The test plan must address unit, integration, contract, e2e, and operational checks, explicitly marking checks not applicable when evidence supports that.
4. Run fresh bounded validation with pipeline_plan_validate and capture Git state with pipeline_git_status. Mark audit. Launch exactly these four Luna/medium roles in one parallel wave: audit-product-traceability, audit-decomposition-dag, audit-cross-layer-integration, audit-test-release-reliability. Give each the goal, repository evidence, assumptions, plan path/content, and validation evidence. Wait for every report. Successful full fan-in enters audit-resolve.
5. Resolve every actionable Luna finding in the plan once, or reject it with specific evidence. Revalidate the plan.
6. Mark final-audit. Launch one independent Terra/high final-audit child. Give it the original goal, synthesized repository evidence, assumptions, current plan path/content, and fresh validation evidence. Do not include Luna findings or their resolutions. Terra must read and follow the canonical code-review skill in initial mode, adapted from implementation defects to concrete plan-quality defects. Wait for its report; do not retry this role. Successful fan-in enters final-resolve.
7. Resolve Terra's actionable findings in the plan once, or reject them with evidence. Revalidate the artifact. Do not audit again.
8. Mark complete and call pipeline_complete. Supply plan_path as the repository-relative docs/plans/*.md artifact path and factual outcome, changed paths, checks/evidence, assumptions, Git state, report summaries/references, unresolved items/questions, and working_dir. Do not state a READY/readiness verdict.

If a Discover or Luna Audit child fails or returns a report-contract warning, use pipeline_child_send to retry that same child session at most once. If no session was created, spawn one replacement attempt. Children remain read-only and have no grandchildren. Do not delegate plan synthesis or remediation to children.`;
}

export function buildPipelinePrompt(
  definition: PipelineDefinitionId,
  request: PipelineRunRequest,
) {
  if (definition === FEATURE_PIPELINE_ID) {
    return buildFeaturePipelinePrompt(request);
  }
  if (definition === SMALL_FEATURE_PIPELINE_ID) {
    return buildSmallFeaturePipelinePrompt(request);
  }
  return buildPlanPipelinePrompt(request);
}

const ROLE_INSTRUCTIONS: Record<PipelineChildRole, string> = {
  "discover-problem":
    "Identify the actor, their job, the current problem or opportunity, its observable consequence, and the problem boundaries. Produce context that helps Sol formulate sound acceptance criteria. Do not assess roadmap priority, invent ROI, or propose a solution.",
  "discover-outcome":
    "Identify observable desired outcomes and propose candidate acceptance criteria grounded in task and product evidence. Keep criteria user-visible and testable; Sol owns the final feature contract.",
  "discover-context":
    "Inspect the current user journey, neighboring scenarios, direct dependencies and contracts, and relevant repository conventions. Do not broaden into a general architecture audit.",
  "discover-user-scenarios":
    "Map the primary, alternative, empty, error, permission, and before/after user journeys that the feature may need to handle.",
  "discover-product-precedents":
    "Search the current product and repository for similar behaviors, terminology, flows, tests, and interaction or implementation patterns. Use external research only when the task explicitly requires it.",
  "audit-feature-outcome":
    "Review the implemented feature outcome and user scenarios: whether the intended user value exists and the primary, alternate, and failure journeys behave as required.",
  "audit-logic-invariants":
    "Review feature logic: states, transitions, conditions, permissions, rules, invariants, and side effects.",
  "audit-functional-correctness":
    "Review functional correctness: observable behavior, contracts, integrations, edge cases, and data handling.",
  "audit-reliability-regressions":
    "Review reliability and regressions: failures, retries, partial success, stale state, concurrency, and existing flows.",
  "implement-small-feature":
    "Implement the bounded task directly in the supplied workspace, add or update focused tests, run appropriate checks, and retain this session for one post-audit remediation pass. Do not commit or push.",
  "discover-goal-outcomes":
    "Clarify the engineering/product goal, observable outcomes, non-goals, and candidate acceptance criteria using repository evidence. Report unknowns and assumptions Sol must preserve.",
  "discover-frontend-scope":
    "Inspect frontend and UI architecture, user journeys, states, accessibility, responsive behavior, and likely test surfaces relevant to the goal. Explicitly report not applicable when repository evidence shows there is no frontend scope.",
  "discover-backend-scope":
    "Inspect backend, data, API, validation, authorization, migration, integration, and performance scope relevant to the goal. Explicitly report not applicable when repository evidence shows there is no backend scope.",
  "discover-devops-scope":
    "Inspect configuration, runtime wiring, CI, deployment, release, observability, rollout, and rollback scope relevant to the goal. Explicitly report not applicable when repository evidence shows there is no DevOps scope.",
  "discover-testing-strategy":
    "Inspect existing quality conventions and identify appropriate unit, integration, contract, e2e, and operational validation. Mark unsupported test layers not applicable rather than inventing infrastructure.",
  "audit-product-traceability":
    "Audit the plan for goal, non-goal, and candidate-acceptance-criteria traceability. Report only concrete omissions, contradictions, or unverifiable outcomes.",
  "audit-decomposition-dag":
    "Audit task decomposition, stable IDs, likely ownership/paths, dependencies, dependency-safe waves, and verification evidence. Identify concrete cycles, gaps, oversized tasks, or unsafe ordering.",
  "audit-cross-layer-integration":
    "Audit frontend, backend, DevOps, and cross-cutting integration boundaries. Respect evidence-backed not-applicable layers and report only concrete integration gaps.",
  "audit-test-release-reliability":
    "Audit unit/integration/contract/e2e/operational coverage, failure handling, risks, release sequencing, rollout, rollback, and observability for concrete gaps.",
  "final-audit":
    "Perform one independent deep final audit after Luna remediation. Read and follow the available canonical code-review skill in initial mode. For plan-pipeline, adapt its candidate-finding rules to implementation-plan quality and use the plan artifact as the reviewed change. Verify claims with repository and validation evidence and return the canonical structured review result.",
};

const DISCOVERY_REPORT_CONTRACT = `Return exactly one compact JSON object with this shape:
{
  "summary": "role-specific synthesis, including not applicable when evidence supports it",
  "evidence": ["specific task, product, documentation, code, or test evidence"],
  "unknowns": ["material facts that remain unknown"],
  "constraints": ["product or technical boundaries that affect the work"]
}
Do not choose the implementation solution. Important overlap with other discovery roles is allowed.`;

const IMPLEMENTATION_REPORT_CONTRACT = `Return exactly one compact JSON object with this shape:
{
  "summary": "what was implemented or remediated",
  "changedPaths": ["repository-relative path"],
  "checks": ["command and factual result"],
  "assumptions": ["material assumption"],
  "unresolvedItems": ["remaining concrete issue"]
}
changedPaths and checks must each contain at least one concrete entry. Use empty arrays only for assumptions or unresolvedItems when none exist. Do not return a readiness verdict.`;

const LUNA_AUDIT_REPORT_CONTRACT = `Return exactly one compact JSON object with this shape:
{
  "track": "your audit role",
  "findings": [{
    "title": "concise defect",
    "scenario": "concrete reachable scenario or state",
    "expected": "required behavior",
    "actual": "actual or inevitable behavior",
    "affectedPaths": ["path"],
    "relationship": "introduced | regression | materially_worsened | pre_existing | unrelated",
    "evidenceType": "static | test | artifact | reproducer | integration",
    "evidence": "specific proof",
    "impact": 2,
    "confidence": 80,
    "minimalNextAction": "smallest sufficient fix"
  }],
  "unprovenChecks": [{
    "claim": "important unverified behavior",
    "reason": "why current evidence is insufficient",
    "requiredCheck": "exact safe check needed"
  }]
}
Only report real behavior gaps. Omit style, taste, generic hardening, unsupported speculation, impact-1 candidates, confidence below 50, and readiness verdicts. Missing tests are findings only when tied to a demonstrated behavior gap.`;

export function buildPipelineChildPrompt(
  definition: PipelineDefinitionId,
  role: PipelineChildRole,
  request: PipelineRunRequest,
  additionalContext = "",
) {
  const contextSection = additionalContext.trim()
    ? `\nAdditional pipeline context:\n${additionalContext.trim()}\n`
    : "";
  if (definition === SMALL_FEATURE_PIPELINE_ID) {
    const implementer = role === SMALL_FEATURE_IMPLEMENTER_ROLE;
    const reportContract = implementer
      ? IMPLEMENTATION_REPORT_CONTRACT
      : LUNA_AUDIT_REPORT_CONTRACT;
    return `You are the ${implementer ? "persistent Luna implementer" : "read-only Luna auditor"} for role ${role}. ${ROLE_INSTRUCTIONS[role]}

Task:
${request.task}

Working directory:
${request.workingDir}
${contextSection}
Follow loaded AGENTS.md files and applicable skills. Do not spawn children, invoke pipelines/workflows/subagents, prompt the user, commit, push, or mutate external state. ${implementer ? "Use normal coding tools to implement and verify the task." : "Inspect independently and do not edit repository files."} ${reportContract}`;
  }
  const reportContract = role.startsWith("discover-")
    ? DISCOVERY_REPORT_CONTRACT
    : role === "final-audit"
      ? "Return exactly the compact JSON required by the canonical code-review skill. Do not return generic recommendations or strengths."
      : LUNA_AUDIT_REPORT_CONTRACT;
  return `You are a read-only ${definition} child for role ${role}. ${ROLE_INSTRUCTIONS[role]}

Task:
${request.task}

Working directory:
${request.workingDir}
${contextSection}
Inspect independently with normal non-orchestration tools. Do not edit files or external state, commit, push, spawn children, invoke pipelines/workflows/subagents, or prompt the user. ${reportContract}`;
}
