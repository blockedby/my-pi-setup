import { randomBytes } from "node:crypto";

export const PIPELINE_NAME_MAX_LENGTH = 64;
export const PIPELINE_NAME_PATTERN =
  "^[a-z][a-z0-9]*(?:-[a-z0-9]+){2,4}$(?![\\s\\S])";
export const PIPELINE_RUN_ID_PATTERN =
  "^[a-z][a-z0-9]*(?:-[a-z0-9]+){2,4}-[0-9a-f]{8}$(?![\\s\\S])";
export const PIPELINE_RUN_ID_MAX_LENGTH = PIPELINE_NAME_MAX_LENGTH + 1 + 8;
export const PIPELINE_ID_ATTEMPT_LIMIT = 8;

const pipelineNamePattern = new RegExp(PIPELINE_NAME_PATTERN);
const pipelineTokenPattern = /^[0-9a-f]{8}$/;

export const PIPELINE_NAME_DESCRIPTION =
  "Required unchanged lowercase kebab-case base: 3–5 hyphen-separated words, at most 64 characters (for example, replace-heavy-plan-pipeline).";

function nameRuleDiagnostic() {
  return `pipeline_name must be an unchanged lowercase kebab-case base of 3–5 hyphen-separated words, at most ${PIPELINE_NAME_MAX_LENGTH} characters.`;
}

export function assertPipelineName(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`pipeline_name is required. ${nameRuleDiagnostic()}`);
  }
  if (value.length > PIPELINE_NAME_MAX_LENGTH) {
    throw new Error(
      `pipeline_name exceeds the maximum length of ${PIPELINE_NAME_MAX_LENGTH} characters.`,
    );
  }
  if (pipelineNamePattern.exec(value)?.[0] !== value) {
    throw new Error(nameRuleDiagnostic());
  }
}

export function securePipelineToken() {
  return randomBytes(4).toString("hex");
}

export function canonicalPipelineId(pipelineName: string, token: string) {
  assertPipelineName(pipelineName);
  if (
    token.length !== 8 ||
    !pipelineTokenPattern.test(token) ||
    pipelineTokenPattern.exec(token)?.[0] !== token
  ) {
    throw new Error(
      "The pipeline token generator must return exactly eight lowercase hexadecimal characters.",
    );
  }
  return `${pipelineName}-${token}`;
}

const canonicalPipelineIdPattern = new RegExp(PIPELINE_RUN_ID_PATTERN);

export function isCanonicalPipelineId(value: string) {
  return (
    value.length <= PIPELINE_RUN_ID_MAX_LENGTH &&
    canonicalPipelineIdPattern.exec(value)?.[0] === value
  );
}

export function isCanonicalPipelineRunId(value: string, pipelineName: string) {
  return (
    isCanonicalPipelineId(value) &&
    value.startsWith(`${pipelineName}-`) &&
    value.length === pipelineName.length + 9
  );
}
