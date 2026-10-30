import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { discover, fetchUsage } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "nan",
    label: "nan",
    icon: "icon.svg",
    input: inputSchema,
    // The key can be a daemon env var, a key file, or the OpenCode /connect login.
    // Global discovery lists every store that holds a key. Session scope would need a
    // per-agent nan login, which the provider surface does not have, so it returns none.
    discover: (scope) => (scope.kind === "global" ? discover() : Promise.resolve([])),
    fetch: fetchUsage,
  });
  return () => {};
}
