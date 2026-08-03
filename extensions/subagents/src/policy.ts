import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  BackendName,
  ParentContext,
  ReasoningEffort,
  SubagentModelRegistry,
} from "./domain.ts";

export const PI_MODEL_QUOTAS = {
  "openai-codex/gpt-5.6-sol": 4,
  "openai-codex/gpt-5.6-terra": 8,
  "openai-codex/gpt-5.6-luna": 16,
} as const;
export const NON_PI_QUOTA = 4;

export const SUBAGENT_PROFILES = {
  "luna-explore": {
    harness: "pi",
    model: "openai-codex/gpt-5.6-luna",
    reasoningEffort: "high",
    systemPrompt:
      "You are Luna, a read-only exploration subagent. Investigate broadly and independently using the full normal tool set. Do not edit, create, delete, rename, format, commit, push, or otherwise mutate files, configuration, repositories, or external state. Prefer evidence from the current workspace, report exact paths and commands, and separate verified facts from hypotheses.",
  },
  "terra-audit": {
    harness: "pi",
    model: "openai-codex/gpt-5.6-terra",
    reasoningEffort: "high",
    systemPrompt:
      "You are Terra, a deep read-only audit and verification subagent. Use the full normal tool set to trace behavior, test adversarial cases, and verify claims. Do not edit, create, delete, rename, format, commit, push, or otherwise mutate files, configuration, repositories, or external state. Report concrete evidence with exact paths and commands, impact, confidence, and unresolved concerns.",
  },
} as const;

export type SubagentProfile = keyof typeof SUBAGENT_PROFILES;
export type CanonicalPiModelKey = keyof typeof PI_MODEL_QUOTAS;
export type QuotaKey = CanonicalPiModelKey | "non-pi" | "pi-unresolved";

export function profileNames() {
  return Object.keys(SUBAGENT_PROFILES) as SubagentProfile[];
}

export function applySubagentProfile(
  profile: SubagentProfile | undefined,
  options: {
    harness?: BackendName;
    model?: string;
    reasoningEffort?: ReasoningEffort;
  },
) {
  if (!profile) {
    if (!options.harness)
      throw new Error("harness is required without a profile.");
    return { ...options, systemPrompt: undefined };
  }
  if (options.harness || options.model || options.reasoningEffort) {
    throw new Error(
      `Profile "${profile}" fixes harness, model, and reasoning_effort; omit conflicting explicit values.`,
    );
  }
  return { ...SUBAGENT_PROFILES[profile] };
}

export function resolvePiModel(
  registry: SubagentModelRegistry,
  hint: string | undefined,
  inherited: ParentContext["inheritedModel"],
) {
  if (!hint) {
    if (!inherited) return undefined;
    return registry.find(inherited.provider, inherited.id) ?? undefined;
  }
  const slash = hint.indexOf("/");
  if (slash > 0) {
    const provider = hint.slice(0, slash);
    const id = hint.slice(slash + 1);
    const found = registry.find(provider, id);
    if (found) return found;
    throw new Error(`Unknown model "${hint}".`);
  }
  if (inherited) {
    const found = registry.find(inherited.provider, hint);
    if (found) return found;
  }
  const matches = registry.getAll().filter((model) => model.id === hint);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Model "${hint}" exists in multiple providers (${matches.map((model) => model.provider).join(", ")}). Use "provider/${hint}".`,
    );
  }
  throw new Error(`Unknown model "${hint}".`);
}

export function canonicalPiModelKey(
  model: Pick<Model<Api>, "provider" | "id"> | undefined,
): QuotaKey {
  if (!model) return "pi-unresolved";
  const key = `${model.provider}/${model.id}`;
  return key in PI_MODEL_QUOTAS
    ? (key as CanonicalPiModelKey)
    : "pi-unresolved";
}

export function quotaKey(
  backend: BackendName,
  model: Pick<Model<Api>, "provider" | "id"> | undefined,
) {
  return backend === "pi" ? canonicalPiModelKey(model) : "non-pi";
}

export function quotaLimit(key: QuotaKey) {
  if (key === "non-pi" || key === "pi-unresolved") return NON_PI_QUOTA;
  return PI_MODEL_QUOTAS[key];
}

export function createQuotaAdmission() {
  const reservations = new Map<QuotaKey, number>();
  const tryReserve = (key: QuotaKey, active: number) => {
    const reserved = reservations.get(key) ?? 0;
    if (active + reserved >= quotaLimit(key)) return false;
    reservations.set(key, reserved + 1);
    return true;
  };
  const release = (key: QuotaKey) => {
    const reserved = reservations.get(key) ?? 1;
    if (reserved <= 1) reservations.delete(key);
    else reservations.set(key, reserved - 1);
  };
  return {
    tryReserve,
    release,
    reserved: (key: QuotaKey) => reservations.get(key) ?? 0,
  };
}
