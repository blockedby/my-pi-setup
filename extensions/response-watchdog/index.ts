import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { guardProvider, RESPONSE_IDLE_TIMEOUT_MS } from "./guard.ts";

export function registerResponseWatchdog(
  pi: ExtensionAPI,
  idleMs = RESPONSE_IDLE_TIMEOUT_MS,
) {
  const wrapped = new Map<string, object>();
  const install = (ctx: ExtensionContext) => {
    for (const id of new Set(
      ctx.modelRegistry.getAll().map((model) => model.provider),
    )) {
      const provider = ctx.modelRegistry.getProvider(id);
      if (
        !provider ||
        (wrapped.has(id) &&
          ctx.modelRegistry.getRegisteredNativeProvider(id) === wrapped.get(id))
      )
        continue;
      const guarded = guardProvider(provider, idleMs);
      wrapped.set(id, guarded);
      pi.registerProvider(guarded);
    }
  };
  pi.on("session_start", (_event, ctx) => install(ctx));
  pi.on("model_select", (_event, ctx) => install(ctx));
}

export default function responseWatchdog(pi: ExtensionAPI) {
  registerResponseWatchdog(pi);
}
