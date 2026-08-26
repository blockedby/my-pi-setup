import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  PIPELINE_4_LUNA_AUDIT_ROLES,
  PLAN_PIPELINE_ID,
  SMALL_FEATURE_PIPELINE_ID,
  type PipelineDefinitionId,
} from "./domain.ts";

export const PLAN_REQUIRED_SECTIONS = [
  "Goal and non-goals",
  "Evidence and assumptions",
  "Candidate acceptance criteria",
  "Frontend tasks",
  "Backend tasks",
  "DevOps tasks",
  "Cross-cutting tasks",
  "Test plan",
  "Implementation waves",
  "Risks, rollout, and rollback",
  "Unresolved questions",
] as const;

const TASK_FIELDS = [
  "Scope",
  "Likely paths/components",
  "Dependencies",
  "Acceptance/verification evidence",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function markdownSection(content: string, title: string) {
  const heading = new RegExp(`^##\\s+${title}\\s*$`, "mi").exec(content);
  if (!heading) return "";
  const remainder = content.slice(heading.index + heading[0].length);
  const nextHeading = remainder.search(/^##\s+/m);
  return nextHeading < 0 ? remainder : remainder.slice(0, nextHeading);
}

export function validatePlanArtifact(content: string) {
  const issues: string[] = [];
  if (!/^#\s+\S/m.test(content))
    issues.push("A level-one plan title is required.");
  for (const section of PLAN_REQUIRED_SECTIONS) {
    const heading = new RegExp(
      `^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
      "mi",
    );
    if (!heading.test(content)) {
      issues.push(`Missing required section: ${section}.`);
    } else if (!markdownSection(content, section).trim()) {
      issues.push(`Required section is empty: ${section}.`);
    }
  }

  const tasks = [...content.matchAll(/^###\s+(TASK-\d{3,}):\s+.+$/gm)];
  if (tasks.length === 0) {
    issues.push(
      "At least one stable TASK-nnn implementation task is required.",
    );
  }
  const taskIds = tasks.map((match) => match[1]!);
  const duplicateIds = taskIds.filter(
    (id, index) => taskIds.indexOf(id) !== index,
  );
  for (const id of new Set(duplicateIds)) {
    issues.push(`Duplicate task ID: ${id}.`);
  }
  const dependencies = new Map<string, string[]>();
  const taskSections = [
    "Frontend tasks",
    "Backend tasks",
    "DevOps tasks",
    "Cross-cutting tasks",
  ];
  for (const [index, task] of tasks.entries()) {
    const blockStart = task.index! + task[0].length;
    const nextTask = tasks[index + 1]?.index ?? content.length;
    const nextSectionOffset = content.slice(blockStart).search(/^##\s+/m);
    const nextSection =
      nextSectionOffset < 0 ? content.length : blockStart + nextSectionOffset;
    const block = content.slice(blockStart, Math.min(nextTask, nextSection));
    const precedingHeadings = [
      ...content.slice(0, task.index).matchAll(/^##\s+(.+)$/gm),
    ];
    const section = precedingHeadings.at(-1)?.[1]?.trim();
    if (!section || !taskSections.includes(section)) {
      issues.push(
        `${task[1]} must be located in a frontend, backend, DevOps, or cross-cutting task section.`,
      );
    }
    for (const field of TASK_FIELDS) {
      const label = new RegExp(`^-\\s+\\*\\*${field}:\\*\\*\\s+\\S`, "mi");
      if (!label.test(block)) issues.push(`${task[1]} is missing ${field}.`);
    }
    const dependencyText =
      block.match(/^-\s+\*\*Dependencies:\*\*\s+(.+)$/im)?.[1]?.trim() ?? "";
    const dependencyIds = [...dependencyText.matchAll(/TASK-\d{3,}/g)].map(
      (match) => match[0],
    );
    if (
      dependencyText &&
      dependencyIds.length === 0 &&
      !/^(?:none|n\/?a|not applicable)[.!]?$/i.test(dependencyText)
    ) {
      issues.push(`${task[1]} has an unparseable dependency declaration.`);
    }
    dependencies.set(task[1]!, dependencyIds);
  }

  const knownTasks = new Set(taskIds);
  for (const [taskId, dependencyIds] of dependencies) {
    for (const dependencyId of dependencyIds) {
      if (!knownTasks.has(dependencyId)) {
        issues.push(`${taskId} depends on unknown task ${dependencyId}.`);
      } else if (dependencyId === taskId) {
        issues.push(`${taskId} cannot depend on itself.`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): boolean => {
    if (visiting.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    visiting.add(taskId);
    const cyclic = (dependencies.get(taskId) ?? []).some(
      (dependencyId) => knownTasks.has(dependencyId) && visit(dependencyId),
    );
    visiting.delete(taskId);
    visited.add(taskId);
    return cyclic;
  };
  if (taskIds.some((taskId) => visit(taskId))) {
    issues.push("Task dependencies contain a cycle.");
  }

  const wavesContent = markdownSection(content, "Implementation waves");
  const taskWaves = new Map<string, number>();
  let currentWave: number | undefined;
  for (const line of wavesContent.split("\n")) {
    const wave = /\bWave\s+(\d+)\b/i.exec(line);
    if (wave) currentWave = Number(wave[1]);
    if (currentWave === undefined) continue;
    const assignments = line.split(/\b(?:after|depends\s+on)\b/i, 1)[0]!;
    for (const taskId of assignments.match(/TASK-\d{3,}/g) ?? []) {
      if (taskWaves.has(taskId)) {
        issues.push(
          `${taskId} is assigned to more than one implementation wave.`,
        );
      } else {
        taskWaves.set(taskId, currentWave);
      }
    }
  }
  for (const taskId of new Set(taskIds)) {
    if (!taskWaves.has(taskId)) {
      issues.push(`${taskId} is not assigned to an implementation wave.`);
    }
  }
  for (const [taskId, dependencyIds] of dependencies) {
    for (const dependencyId of dependencyIds) {
      const taskWave = taskWaves.get(taskId);
      const dependencyWave = taskWaves.get(dependencyId);
      if (
        taskWave !== undefined &&
        dependencyWave !== undefined &&
        dependencyWave >= taskWave
      ) {
        issues.push(
          `${taskId} must be in a later wave than dependency ${dependencyId}.`,
        );
      }
    }
  }

  const testContent = markdownSection(content, "Test plan");
  for (const check of [
    "unit",
    "integration",
    "contract",
    "e2e",
    "operational",
  ]) {
    if (!new RegExp(`\\b${check}\\b`, "i").test(testContent)) {
      issues.push(
        `Test plan must address ${check} checks or mark them not applicable.`,
      );
    }
  }
  return issues;
}

function normalizePlanPath(workingDir: string, planPath: string) {
  const relativePath = path.isAbsolute(planPath)
    ? path.relative(workingDir, planPath)
    : path.normalize(planPath);
  if (
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath) ||
    !/^docs[\\/]plans[\\/].+\.md$/i.test(relativePath)
  ) {
    throw new Error(
      "plan_path must be a repository-local docs/plans/*.md path.",
    );
  }
  return relativePath;
}

function pathIsInside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertExistingParentInside(realWorkingDir: string, directory: string) {
  let existing = directory;
  while (true) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  const realExisting = fs.realpathSync(existing);
  if (!pathIsInside(realWorkingDir, realExisting)) {
    throw new Error("plan_path parent resolves outside working_dir.");
  }
}

export function resolvePlanArtifact(workingDir: string, planPath: string) {
  const relativePath = normalizePlanPath(workingDir, planPath);
  const absolutePath = path.resolve(workingDir, relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`plan_path does not identify a file: ${absolutePath}`);
  }
  const artifactStat = fs.lstatSync(absolutePath);
  if (artifactStat.isSymbolicLink()) {
    throw new Error("plan_path must not be a symbolic link.");
  }
  const realWorkingDir = fs.realpathSync(workingDir);
  const realArtifact = fs.realpathSync(absolutePath);
  if (!pathIsInside(realWorkingDir, realArtifact)) {
    throw new Error("plan_path resolves outside working_dir.");
  }
  const content = fs.readFileSync(realArtifact, "utf8");
  const issues = validatePlanArtifact(content);
  if (issues.length > 0) {
    throw new Error(`Plan artifact contract failed: ${issues.join(" ")}`);
  }
  return {
    absolutePath,
    relativePath: relativePath.split(path.sep).join("/"),
    content,
    digest: createHash("sha256").update(content).digest("hex"),
    device: artifactStat.dev,
    inode: artifactStat.ino,
  };
}

export function writePlanArtifact(
  workingDir: string,
  planPath: string,
  content: string,
) {
  const issues = validatePlanArtifact(content);
  if (issues.length > 0) {
    throw new Error(`Plan artifact contract failed: ${issues.join(" ")}`);
  }
  const relativePath = normalizePlanPath(workingDir, planPath);
  const absolutePath = path.resolve(workingDir, relativePath);
  const directory = path.dirname(absolutePath);
  const realWorkingDir = fs.realpathSync(workingDir);
  assertExistingParentInside(realWorkingDir, directory);
  fs.mkdirSync(directory, { recursive: true });
  const realDirectory = fs.realpathSync(directory);
  if (!pathIsInside(realWorkingDir, realDirectory)) {
    throw new Error("plan_path resolves outside working_dir.");
  }
  if (
    fs.existsSync(absolutePath) &&
    fs.lstatSync(absolutePath).isSymbolicLink()
  ) {
    throw new Error("plan_path must not be a symbolic link.");
  }
  fs.writeFileSync(absolutePath, content, "utf8");
  return resolvePlanArtifact(workingDir, relativePath);
}

function parseJsonReport(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function exactKeys(report: Record<string, unknown>, allowed: string[]) {
  return Object.keys(report).every((key) => allowed.includes(key));
}

function nonEmptyString(value: unknown, maxLength = Number.POSITIVE_INFINITY) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function validDiscoveryReport(report: Record<string, unknown>) {
  return (
    exactKeys(report, ["summary", "evidence", "unknowns", "constraints"]) &&
    nonEmptyString(report.summary) &&
    stringArray(report.evidence) &&
    stringArray(report.unknowns) &&
    stringArray(report.constraints)
  );
}

function validLunaFinding(value: unknown) {
  if (!isRecord(value)) return false;
  const keys = [
    "title",
    "scenario",
    "expected",
    "actual",
    "affectedPaths",
    "relationship",
    "evidenceType",
    "evidence",
    "impact",
    "confidence",
    "minimalNextAction",
  ];
  return (
    exactKeys(value, keys) &&
    keys.every((key) => key in value) &&
    [
      value.title,
      value.scenario,
      value.expected,
      value.actual,
      value.evidence,
      value.minimalNextAction,
    ].every((item) => nonEmptyString(item)) &&
    Array.isArray(value.affectedPaths) &&
    value.affectedPaths.length > 0 &&
    value.affectedPaths.every((item) => nonEmptyString(item)) &&
    [
      "introduced",
      "regression",
      "materially_worsened",
      "pre_existing",
      "unrelated",
    ].includes(String(value.relationship)) &&
    ["static", "test", "artifact", "reproducer", "integration"].includes(
      String(value.evidenceType),
    ) &&
    Number.isInteger(value.impact) &&
    Number(value.impact) >= 2 &&
    Number(value.impact) <= 4 &&
    Number.isInteger(value.confidence) &&
    Number(value.confidence) >= 50 &&
    Number(value.confidence) <= 100
  );
}

function validUnprovenCheck(value: unknown) {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, ["claim", "reason", "requiredCheck"]) &&
    [value.claim, value.reason, value.requiredCheck].every((item) =>
      nonEmptyString(item),
    )
  );
}

function validImplementationReport(report: Record<string, unknown>) {
  const validStrings = (value: unknown, minimum = 0) =>
    Array.isArray(value) &&
    value.length >= minimum &&
    value.every((item) => nonEmptyString(item));
  return (
    exactKeys(report, [
      "summary",
      "changedPaths",
      "checks",
      "assumptions",
      "unresolvedItems",
    ]) &&
    nonEmptyString(report.summary) &&
    validStrings(report.changedPaths, 1) &&
    validStrings(report.checks, 1) &&
    validStrings(report.assumptions) &&
    validStrings(report.unresolvedItems)
  );
}

function validLunaAuditReport(report: Record<string, unknown>) {
  return (
    exactKeys(report, ["track", "findings", "unprovenChecks"]) &&
    nonEmptyString(report.track) &&
    Array.isArray(report.findings) &&
    report.findings.every(validLunaFinding) &&
    Array.isArray(report.unprovenChecks) &&
    report.unprovenChecks.every(validUnprovenCheck)
  );
}

function validCanonicalFinding(value: unknown) {
  if (!isRecord(value)) return false;
  const required = [
    "id",
    "title",
    "locations",
    "scenario",
    "expected",
    "actual",
    "evidence_type",
    "evidence",
    "impact",
    "confidence",
    "relationship",
    "verification_status",
    "disposition",
    "next_action",
    "retain_regression_test",
  ];
  if (
    !required.every((key) => key in value) ||
    !exactKeys(value, [...required, "closure_condition"])
  ) {
    return false;
  }
  const locationsValid =
    Array.isArray(value.locations) &&
    value.locations.length > 0 &&
    value.locations.every((location) => {
      if (!isRecord(location) || !nonEmptyString(location.path)) return false;
      if (!exactKeys(location, ["path", "start_line", "end_line"])) {
        return false;
      }
      const hasStart = "start_line" in location;
      const hasEnd = "end_line" in location;
      return (
        hasStart === hasEnd &&
        (!hasStart ||
          (Number.isInteger(location.start_line) &&
            Number(location.start_line) >= 1 &&
            Number.isInteger(location.end_line) &&
            Number(location.end_line) >= Number(location.start_line)))
      );
    });
  const dispositionValid =
    value.disposition === "BLOCK" || value.disposition === "FOLLOW_UP";
  return (
    /^REV-(?:00[1-9]|0[1-9][0-9]|[1-9][0-9]{2,})$/.test(String(value.id)) &&
    nonEmptyString(value.title, 120) &&
    locationsValid &&
    [
      value.scenario,
      value.expected,
      value.actual,
      value.evidence,
      value.next_action,
    ].every((item) => nonEmptyString(item)) &&
    [
      "static_proof",
      "existing_test",
      "runtime_artifact",
      "regression_test",
      "contract_test",
      "local_reproducer",
      "integration_check",
      "authorized_runtime_check",
    ].includes(String(value.evidence_type)) &&
    Number.isInteger(value.impact) &&
    Number(value.impact) >= 1 &&
    Number(value.impact) <= 4 &&
    Number.isInteger(value.confidence) &&
    Number(value.confidence) >= 0 &&
    Number(value.confidence) <= 100 &&
    [
      "introduced",
      "regression",
      "materially_worsened",
      "pre_existing",
      "unrelated",
    ].includes(String(value.relationship)) &&
    ["not_required", "verified", "unproven"].includes(
      String(value.verification_status),
    ) &&
    dispositionValid &&
    typeof value.retain_regression_test === "boolean" &&
    (value.disposition !== "BLOCK" || nonEmptyString(value.closure_condition))
  );
}

function validCanonicalInitialReview(report: Record<string, unknown>) {
  return (
    exactKeys(report, [
      "mode",
      "base_sha",
      "head_sha",
      "verdict",
      "findings",
      "summary",
    ]) &&
    report.mode === "initial" &&
    nonEmptyString(report.base_sha) &&
    String(report.base_sha).length >= 7 &&
    nonEmptyString(report.head_sha) &&
    String(report.head_sha).length >= 7 &&
    ["READY", "READY_WITH_FOLLOW_UPS", "NOT_READY"].includes(
      String(report.verdict),
    ) &&
    Array.isArray(report.findings) &&
    report.findings.every(validCanonicalFinding) &&
    nonEmptyString(report.summary, 500)
  );
}

export function validatePipelineReport(
  definition: PipelineDefinitionId,
  role: string,
  text: string,
) {
  const report = parseJsonReport(text);
  if (!isRecord(report)) return ["Report must be exactly one JSON object."];

  if (definition === SMALL_FEATURE_PIPELINE_ID) {
    if (role === "implement-small-feature") {
      return validImplementationReport(report)
        ? []
        : [
            "Implementation report must contain exactly a non-empty summary, non-empty changedPaths and checks string arrays, plus assumptions and unresolvedItems string arrays.",
          ];
    }
    return PIPELINE_4_LUNA_AUDIT_ROLES.some(
      (auditRole) => auditRole === role,
    ) && validLunaAuditReport(report)
      ? []
      : [
          "Small-feature Luna audit must match the complete track, findings, and unprovenChecks schema.",
        ];
  }

  if (role.startsWith("discover-")) {
    return validDiscoveryReport(report)
      ? []
      : [
          "Discovery report must contain exactly a non-empty summary plus evidence, unknowns, and constraints string arrays.",
        ];
  }
  if (role === "final-audit") {
    return validCanonicalInitialReview(report)
      ? []
      : [
          "Final audit must use the complete canonical initial-review JSON result schema.",
        ];
  }
  return validLunaAuditReport(report)
    ? []
    : [
        "Luna audit report must match the complete track, findings, and unprovenChecks schema.",
      ];
}
