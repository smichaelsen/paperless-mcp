import { log } from "../logging";
import type { EffectiveToolPolicy } from "../mcp/toolPolicy";

/** Log only the resolved names, never credentials or invocation arguments. */
export function logEffectiveToolPolicy(policy: EffectiveToolPolicy): void {
  const toolNames = [...policy.enabledTools].sort();
  const bulkEditMethods = [...policy.bulkEditMethods].sort();
  log("info", "tool_access_mode", {
    mode: policy.mode.label,
    writes: policy.mode.writes,
    destructive: policy.mode.destructive,
    tools: toolNames.length,
    tool_names: toolNames.join(",") || "(none)",
    bulk_edit_methods: bulkEditMethods.join(",") || "(none)",
  });
}
