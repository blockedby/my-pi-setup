import { join, resolve } from "node:path";

/** Match known managed adapter sources without removing unrelated packages. */
export const isLegacyMcpAdapterSource = (source, agentDir) => {
  if (typeof source !== "string") return false;
  if (
    source === "npm:pi-mcp-adapter" ||
    source.startsWith("npm:pi-mcp-adapter@")
  )
    return true;
  const resolved = resolve(agentDir, source);
  return ["runtime", "npm"].some(
    (prefix) =>
      resolved === join(agentDir, prefix, "node_modules", "pi-mcp-adapter"),
  );
};
