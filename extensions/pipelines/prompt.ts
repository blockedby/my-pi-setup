import type { PipelineChildRole, PipelineRunRequest } from "./domain.ts";

export function buildFeaturePipelinePrompt(request: PipelineRunRequest) {
  return `You are the persistent Sol/high pipeline agent for one feature-pipeline run.

Task:
${request.task}

Working directory:
${request.workingDir}

Own orchestration, planning, implementation, remediation, and the factual completion handoff. Follow the task, loaded AGENTS.md files, and applicable skills. Use normal coding tools for implementation and only the run-scoped pipeline tools for orchestration. Do not invoke raw workflows or ordinary subagents.

Run this fixed graph yourself; the host records your actions but does not schedule it:
1. Mark discover. Launch these five Luna/medium roles in one parallel wave: discover-problem, discover-outcome, discover-context, discover-user-scenarios, discover-product-precedents. Wait for every report in this same session.
2. Synthesize the reports into a feature contract, candidate acceptance criteria, and explicit assumptions. Make reasonable assumptions when evidence remains incomplete; do not pause for user input. Mark build, then plan and implement the feature yourself.
3. Mark audit. Launch these four Luna/medium roles in one parallel wave: audit-feature-outcome, audit-logic-invariants, audit-functional-correctness, audit-reliability-regressions. Give each the feature contract, assumptions, current change, and check evidence as additional context. Wait for every report.
4. Mark audit-resolve. Evaluate every concrete finding; fix it or reject it with specific evidence. Run appropriate checks.
5. Mark final-audit. Launch one Terra/high final-audit child. Give it only the original task, feature contract, assumptions, current change, and current checks. Do not include prior Luna findings or their resolutions. Wait for its independent report.
6. Mark final-resolve. Evaluate and resolve the Terra findings yourself. Do not run another audit afterward.
7. Mark complete and call pipeline_complete with structured facts only, including every material assumption.

If a Discover or Luna Audit child fails, use pipeline_child_send to retry that same child session at most once. If no session was created, spawn one replacement attempt. Do not retry final-audit. Do not delegate implementation to children. Completion has no readiness label: report outcome, changed paths, checks/evidence, assumptions, Git/commit observations when applicable, report summaries or references, unresolved items, and working_dir.`;
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
  "final-audit":
    "Perform one independent deep final audit of the current feature after Luna remediation. Read and follow the available canonical code-review skill in initial mode. Verify claims with concrete evidence and return its required structured review result.",
};

const DISCOVERY_REPORT_CONTRACT = `Return exactly one compact JSON object with this shape:
{
  "summary": "role-specific synthesis",
  "evidence": ["specific task, product, documentation, code, or test evidence"],
  "unknowns": ["material facts that remain unknown"],
  "constraints": ["product or technical boundaries that affect the feature"]
}
Do not choose the implementation solution. Important overlap with other discovery roles is allowed.`;

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
  role: PipelineChildRole,
  request: PipelineRunRequest,
  additionalContext = "",
) {
  const reportContract = role.startsWith("discover-")
    ? DISCOVERY_REPORT_CONTRACT
    : role === "final-audit"
      ? "Return the compact JSON required by the canonical code-review skill. Do not return generic recommendations or strengths."
      : LUNA_AUDIT_REPORT_CONTRACT;
  const contextSection = additionalContext.trim()
    ? `\nAdditional pipeline context:\n${additionalContext.trim()}\n`
    : "";
  return `You are a read-only pipeline child for role ${role}. ${ROLE_INSTRUCTIONS[role]}

Task:
${request.task}

Working directory:
${request.workingDir}
${contextSection}
Inspect independently with normal non-orchestration tools. Do not edit files or external state, commit, push, spawn children, invoke pipelines/workflows/subagents, or prompt the user. ${reportContract}`;
}
