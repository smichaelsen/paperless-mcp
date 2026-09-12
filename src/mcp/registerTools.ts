/**
 * Tool registration, with the advertised JSON Schemas kept closed.
 *
 * The MCP SDK builds each tool's `inputSchema` by wrapping the declared zod
 * shape in a plain `z.object(...)`. Under zod 3 that emitted
 * `"additionalProperties": false`; zod 4's JSON-Schema emitter omits it for the
 * default `strip` mode. Dropping it is a client-visible regression:
 *
 * - a client that validates arguments locally used to reject
 *   `list_tags({page_number: 3})`; without the keyword the typo is forwarded,
 *   silently stripped by the server, and the model believes it got page 3;
 * - OpenAI strict function calling requires `additionalProperties: false` on
 *   every object, so a bridge forwarding these schemas breaks without it.
 *
 * So every object in every advertised schema is annotated with JSON-Schema
 * metadata that restores the keyword. Metadata only affects what is
 * *advertised*: parsing stays `strip`, exactly as before, so an unknown key is
 * still silently dropped rather than newly rejected. Making the objects
 * `z.strictObject` would have changed that runtime contract too.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { registerCorrespondentTools } from "../tools/correspondents";
import { registerDocumentTools } from "../tools/documents";
import { registerDocumentTypeTools } from "../tools/documentTypes";
import { registerTagTools } from "../tools/tags";

/** The JSON-Schema keyword this module restores. */
const CLOSED_OBJECT = { additionalProperties: false } as const;

type AnyZodType = z.ZodType<any, any, any>;

/** A tool's declared arguments: field name -> zod schema. */
export type ToolShape = Record<string, AnyZodType>;

/** Merge metadata into a schema's global registry entry, keeping `.describe()`. */
function markClosed(schema: AnyZodType): void {
  const existing = (z.globalRegistry.get(schema) ?? {}) as Record<
    string,
    unknown
  >;
  z.globalRegistry.add(schema, { ...existing, ...CLOSED_OBJECT } as never);
}

/**
 * Walk a zod schema and mark every object it contains — through optionals,
 * arrays, unions and records — so nested objects are advertised closed too
 * (the `permissions` trees of the bulk-edit tools are three levels deep).
 */
function markObjectsClosed(schema: unknown, depth = 0): void {
  if (!schema || typeof schema !== "object" || depth > 10) return;

  const def = (schema as { _zod?: { def?: any } })._zod?.def;
  if (!def) return;

  switch (def.type) {
    case "object":
      markClosed(schema as AnyZodType);
      for (const child of Object.values(def.shape ?? {})) {
        markObjectsClosed(child, depth + 1);
      }
      break;
    case "optional":
    case "nullable":
    case "nonoptional":
    case "default":
    case "prefault":
    case "readonly":
    case "catch":
      markObjectsClosed(def.innerType, depth + 1);
      break;
    case "array":
      markObjectsClosed(def.element, depth + 1);
      break;
    case "union":
      for (const option of def.options ?? []) {
        markObjectsClosed(option, depth + 1);
      }
      break;
    case "record":
      markObjectsClosed(def.valueType, depth + 1);
      break;
    case "tuple":
      for (const item of def.items ?? []) markObjectsClosed(item, depth + 1);
      break;
    default:
      break;
  }
}

/**
 * Turn a declared tool shape into the object schema to advertise: the same
 * `z.object(shape)` the SDK would have built, with every object in the tree
 * annotated as closed.
 */
export function closedObjectFromShape(shape: ToolShape) {
  for (const field of Object.values(shape)) markObjectsClosed(field);
  return z.object(shape).meta(CLOSED_OBJECT as never);
}

/** What `register*Tools(server, api)` needs from the server. */
export interface ToolRegistrar {
  tool(
    name: string,
    description: string,
    shape: ToolShape,
    handler: (args: any, extra: any) => Promise<any>
  ): void;
}

/**
 * Adapt an `McpServer` so `server.tool(name, description, shape, handler)`
 * registers through `registerTool` with a closed object schema. The deprecated
 * `tool()` overload only accepts a raw shape, which is exactly the path that
 * loses the keyword.
 */
export function closedSchemaRegistrar(server: McpServer): ToolRegistrar {
  return {
    tool(name, description, shape, handler) {
      server.registerTool(
        name,
        { description, inputSchema: closedObjectFromShape(shape) },
        handler as never
      );
    },
  };
}

/** Register the whole Paperless tool surface on `server`. */
export function registerAllTools(server: McpServer, api: PaperlessAPI): void {
  // The tool modules only ever call `server.tool(...)`; one of them declares
  // its parameter as `McpServer`, so the adapter is cast to satisfy it.
  const registrar = closedSchemaRegistrar(server) as unknown as McpServer;
  registerDocumentTools(registrar, api);
  registerTagTools(registrar, api);
  registerCorrespondentTools(registrar, api);
  registerDocumentTypeTools(registrar, api);
}
