import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Extra subscription providers are aliases of the same Codex model family. */
export function isCodexSubscriptionProvider(provider: string) {
  return /^openai-codex(?:-[1-9]\d*)?$/.test(provider);
}

/** Base Codex hints select a model, not an account. Numbered hints stay exact. */
export function subscriptionModelHint(hint: string, parentProvider?: string) {
  if (
    hint.startsWith("openai-codex/") &&
    parentProvider &&
    isCodexSubscriptionProvider(parentProvider)
  ) {
    return `${parentProvider}/${hint.slice("openai-codex/".length)}`;
  }
  return hint;
}

/** Never fall back to another subscription when its requested model is absent. */
export function resolveSubscriptionModel(
  registry: Pick<ModelRegistry, "find">,
  hint: string,
  parentProvider?: string,
) {
  const actual = subscriptionModelHint(hint, parentProvider);
  const slash = actual.indexOf("/");
  const model = registry.find(actual.slice(0, slash), actual.slice(slash + 1));
  if (model) return model;
  throw new Error(
    actual === hint
      ? `Unknown model "${actual}".`
      : `Unknown model "${actual}" (requested "${hint}" on inherited Codex subscription "${parentProvider}"). No fallback to another subscription.`,
  );
}
