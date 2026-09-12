/**
 * The `--http` Express application.
 *
 * ## Isolation model: one `McpServer` per client connection, never shared
 *
 * An `McpServer` is a stateful object: `Protocol.connect()` stores the
 * transport on the instance, and every response is written to *that* stored
 * transport. Connecting one server to a transport created per HTTP request
 * therefore routes whatever is in flight to whichever client connected last.
 * SDK 1.30 makes this explicit — a second `connect()` on the same instance now
 * throws `Already connected to a transport [...] or use a separate Protocol
 * instance per connection`.
 *
 * So `createServer()` is called once per connection and its result is never
 * reused. For Streamable HTTP a connection is a single request (stateless
 * mode); for the legacy SSE route it is the lifetime of the event stream.
 *
 * ## Stateless, deliberately
 *
 * Streamable HTTP runs with `sessionIdGenerator: undefined`. This server has
 * nothing per-client to remember: the Paperless URL and token are fixed at
 * startup, tools are pure request/response, and nothing is server-initiated, so
 * a session map would only add cross-client state to leak and to expire. The
 * SDK reinforces the choice — a stateless transport refuses to handle a second
 * request ("Stateless transport cannot be reused across requests") — hence a
 * fresh transport *and* a fresh server per request, and `GET`/`DELETE /mcp`
 * (resumption and session teardown) stay 405.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Express, Request, Response } from "express";
import { errorClass, log } from "../logging";
import { registerLegacySseRoutes } from "./legacySse";
import {
  dnsRebindingProtection,
  HttpSecurityConfig,
  resolveHttpSecurity,
  transportSecurityOptions,
} from "./security";

/** Builds a fully registered, *unconnected* MCP server. Called per connection. */
export type McpServerFactory = () => McpServer;

export interface McpHttpAppOptions {
  createServer: McpServerFactory;
  security?: HttpSecurityConfig;
  /**
   * Legacy `GET /sse` + `POST /messages` routes (issue #11 will gate or remove
   * them). They are registered last and in one call, so gating is a one-liner.
   */
  enableLegacySse?: boolean;
}

/** JSON-RPC error body, the shape the SDK uses for transport-level failures. */
export function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json(jsonRpcError(-32000, "Method not allowed."));
}

export function createMcpHttpApp(options: McpHttpAppOptions): Express {
  const { createServer } = options;
  const security = options.security ?? resolveHttpSecurity(process.env);
  const transportOptions = transportSecurityOptions(security);

  const app = express();
  // Ordering matters: reject before any body is handed to a transport.
  app.use(dnsRebindingProtection(security));
  app.use(express.json());

  app.post("/mcp", async (req: Request, res: Response) => {
    let server: McpServer | undefined;
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      // Closing the server closes its transport too; both are idempotent.
      void server?.close().catch((error: unknown) => {
        log("warn", "mcp_connection_close_failed", {
          error_class: errorClass(error),
        });
      });
    };
    res.on("close", dispose);

    try {
      // Fresh server *and* fresh transport: two unrelated clients share no
      // mutable object, so neither can observe the other's responses or state.
      server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        ...transportOptions,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      // Never `console.error(error)`: a raw error object can carry a
      // credential-bearing URL into the log.
      log("error", "mcp_request_failed", { error_class: errorClass(error) });
      dispose();
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, "Internal server error"));
      } else {
        res.end();
      }
    }
  });

  // Stateless mode has no resumable stream and no session to delete.
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  if (options.enableLegacySse !== false) {
    registerLegacySseRoutes(app, { createServer, transportOptions });
  }

  return app;
}
