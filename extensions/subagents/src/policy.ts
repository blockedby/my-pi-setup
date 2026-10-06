import type { Api, Model } from "@earendil-works/pi-ai";
import {
  isCodexSubscriptionProvider,
  resolveSubscriptionModel,
} from "../../shared/codex-subscription.ts";
import type {
  BackendName,
  ParentContext,
  ReasoningEffort,
  SubagentModelRegistry,
} from "./domain.ts";

// These quotas govern direct subagent admission only. Fixed pipeline graphs
// must not import or apply them to pipeline roots or children.
export const PI_MODEL_QUOTAS = {
  "openai-codex/gpt-6.1-sol": 4,
  "openai-codex/gpt-6-luna": 16,
  "openai-codex/gpt-6-astra": 4,
  "openai-codex/gpt-5.6-sol": 4,
  "openai-codex/gpt-5.6-terra": 8,
  "openai-codex/gpt-5.6-luna": 16,
} as const;
export const NON_PI_QUOTA = 4;

const COMMON_ROLE_GUIDANCE =
  "Own the complete assigned task independently within its scope; do not split tests or documentation into separate workers by default. Do not delegate recursively or ask the user questions; report blockers to the main agent. Do not change credentials or perform unrequested Git delivery or external-state writes. The main agent owns integration and final acceptance. Report the recommended next step and conclusion first, then concise evidence, validation, and remaining risks.";

const ROLE_PROFILES = {
  explore: {
    role: "explore",
    readOnly: true,
    harness: "pi",
    model: "openai-codex/gpt-6-luna",
    reasoningEffort: "max",
    systemPrompt: `Explore the assigned goal broadly and independently. This is a read-only role, not an OS sandbox: do not mutate files, configuration, repositories, or external state, including through commands or checks. Separate verified facts from hypotheses and cite relevant paths. ${COMMON_ROLE_GUIDANCE}`,
  },
  implement: {
    role: "implement",
    readOnly: false,
    harness: "pi",
    model: "openai-codex/gpt-6.1-sol",
    reasoningEffort: "medium",
    systemPrompt: `Implement the assigned goal, including related tests and documentation as needed. Use normal tools to make scoped workspace changes and run proportionate checks. Report changed paths and executed results. ${COMMON_ROLE_GUIDANCE}`,
  },
  review: {
    role: "review",
    readOnly: true,
    harness: "pi",
    model: "openai-codex/gpt-6.1-sol",
    reasoningEffort: "medium",
    systemPrompt: `Review the assigned goal and scope for actionable defects using evidence, impact, and confidence. This is a read-only role, not an OS sandbox: do not mutate files, configuration, repositories, or external state, including through commands or checks. Report findings with locations, consequences, and minimal remediation; distinguish unproven risks. ${COMMON_ROLE_GUIDANCE}`,
  },
} as const;

export const SUBAGENT_PROFILES = {
  ...ROLE_PROFILES,
  // Compatibility names preserve roles, not obsolete model generations.
  "luna-explore": ROLE_PROFILES.explore,
  "luna-worker": {
    ...ROLE_PROFILES.implement,
    model: "openai-codex/gpt-6-luna",
    reasoningEffort: "max",
  },
  "sol-worker": ROLE_PROFILES.implement,
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
  const defaults = SUBAGENT_PROFILES[profile];
  if (options.harness && options.harness !== defaults.harness) {
    // Other backends currently ignore profileSystemPrompt. Do not silently
    // drop role semantics or substitute a different harness.
    throw new Error(
      `Profile "${profile}" requires the Pi harness to preserve role guidance; harness "${options.harness}" is incompatible. Use Pi or omit the profile.`,
    );
  }
  return {
    ...defaults,
    model: options.model ?? defaults.model,
    reasoningEffort: options.reasoningEffort ?? defaults.reasoningEffort,
  };
}

export function resolvePiModel(
  registry: SubagentModelRegistry,
  hint: string | undefined,
  inherited: ParentContext["inheritedModel"],
) {
  if (!hint) {
    if (!inherited) return undefined;
    if (isCodexSubscriptionProvider(inherited.provider))
      return resolveSubscriptionModel(
        registry,
        `${inherited.provider}/${inherited.id}`,
      );
    return registry.find(inherited.provider, inherited.id) ?? undefined;
  }
  const slash = hint.indexOf("/");
  if (slash > 0) {
    return resolveSubscriptionModel(registry, hint, inherited?.provider);
  }
  if (inherited) {
    const found = registry.find(inherited.provider, hint);
    if (found) return found;
  }
  const matches = registry.getAll().filter((model) => model.id === hint);
  if (
    inherited &&
    isCodexSubscriptionProvider(inherited.provider) &&
    (matches.length === 0 ||
      matches.some((model) => isCodexSubscriptionProvider(model.provider)))
  ) {
    throw new Error(
      `Unknown model "${inherited.provider}/${hint}" on inherited Codex subscription. No fallback to another subscription.`,
    );
  }
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
  // Legacy and current IDs share family capacity; switching versions cannot
  // double a family's direct-subagent allowance.
  const provider = isCodexSubscriptionProvider(model.provider)
    ? "openai-codex"
    : model.provider;
  const identity = `${provider}/${model.id}`;
  const key =
    identity === "openai-codex/gpt-5.6-sol"
      ? "openai-codex/gpt-6.1-sol"
      : identity === "openai-codex/gpt-5.6-luna"
        ? "openai-codex/gpt-6-luna"
        : identity === "openai-codex/gpt-5.6-astra"
          ? "openai-codex/gpt-6-astra"
          : identity;
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
