/**
 * Shared harness for the access-mode tests: a real `McpServer` with the real
 * registrations, driven by a real MCP `Client` over an in-memory transport, so
 * what the tests see is literally what a client would see in `tools/list`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PaperlessAPI } from "../../src/api/PaperlessAPI";
import { toolAccessMode } from "../../src/config/toolAccess";
import type { ToolAccessMode } from "../../src/config/toolAccess";
import { registerAllTools } from "../../src/mcp/registerTools";
import {
  BULK_EDIT_DESTRUCTIVE_METHODS,
  BULK_EDIT_WRITE_METHODS,
  type EffectiveToolPolicy,
  resolveEffectiveToolPolicy,
  TOOL_POLICIES,
} from "../../src/mcp/toolPolicy";

export const BASE_URL = "https://paperless.example.invalid";

/** The three modes, named as the README names them. */
export const MODES: Record<string, ToolAccessMode> = {
  "read-only": toolAccessMode(false, false),
  write: toolAccessMode(true, false),
  destructive: toolAccessMode(true, true),
};

/** Explicitly allow the whole surface a mode permits. */
export function fullPolicyInMode(mode: ToolAccessMode) {
  return resolveEffectiveToolPolicy(mode, {
    enabledTools: Object.keys(TOOL_POLICIES),
    bulkEditMethods: [
      ...BULK_EDIT_WRITE_METHODS,
      ...BULK_EDIT_DESTRUCTIVE_METHODS,
    ],
  });
}

export async function connectInMode(mode: ToolAccessMode): Promise<Client> {
  return connectWithPolicy(fullPolicyInMode(mode));
}

export async function connectWithPolicy(
  policy: EffectiveToolPolicy
): Promise<Client> {
  const api = new PaperlessAPI(BASE_URL, "s3cr3t-token-value");
  const server = new McpServer({ name: "paperless-ngx", version: "1.0.0" });
  registerAllTools(server, api, policy);

  const client = new Client({ name: "mode-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

/** Sorted tool names advertised in `mode`. */
export async function toolNamesInMode(mode: ToolAccessMode): Promise<string[]> {
  const client = await connectInMode(mode);
  return toolNamesFromClient(client);
}

export async function toolNamesWithPolicy(
  policy: EffectiveToolPolicy
): Promise<string[]> {
  const client = await connectWithPolicy(policy);
  return toolNamesFromClient(client);
}

async function toolNamesFromClient(client: Client): Promise<string[]> {
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

/** Every string value appearing in an `enum` anywhere in a JSON Schema. */
export function collectEnumValues(
  node: unknown,
  found: string[] = []
): string[] {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) collectEnumValues(child, found);
    return found;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "enum" && Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") found.push(entry);
      }
      continue;
    }
    collectEnumValues(value, found);
  }
  return found;
}

/** Every property name appearing anywhere in a JSON Schema's `properties`. */
export function collectPropertyNames(
  node: unknown,
  found: string[] = []
): string[] {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) collectPropertyNames(child, found);
    return found;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "properties" && value && typeof value === "object") {
      found.push(...Object.keys(value as Record<string, unknown>));
    }
    collectPropertyNames(value, found);
  }
  return found;
}
