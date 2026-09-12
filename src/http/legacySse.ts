/**
 * Legacy HTTP+SSE transport (`GET /sse` + `POST /messages`), superseded by
 * Streamable HTTP. Kept for older clients; issue #11 will gate or remove it.
 *
 * Everything lives behind one `registerLegacySseRoutes(app, ...)` call so the
 * gate is a single `if`. The isolation rule is the same as for `/mcp`: one
 * `McpServer` per connection. Here a connection is the SSE stream, so the
 * server instance lives in the session entry alongside its transport and is
 * closed with it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Express, Request, Response } from "express";
import { errorClass, log } from "../logging";
import { McpServerFactory } from "./app";

export interface LegacySseOptions {
  createServer: McpServerFactory;
  transportOptions?: {
    enableDnsRebindingProtection?: boolean;
    allowedOrigins?: string[];
  };
}

interface SseSession {
  transport: SSEServerTransport;
  server: McpServer;
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}

export function registerLegacySseRoutes(
  app: Express,
  options: LegacySseOptions
): void {
  const { createServer, transportOptions = {} } = options;

  // Session id -> that client's own server and transport. Nothing in here is
  // ever handed to another session.
  const sessions = new Map<string, SseSession>();

  app.get("/sse", async (_req: Request, res: Response) => {
    // stderr, not stdout: stdout is the MCP framing channel under stdio.
    log("info", "sse_connection_opening");
    try {
      const server = createServer();
      const transport = new SSEServerTransport("/messages", res, {
        ...transportOptions,
      });
      sessions.set(transport.sessionId, { transport, server });
      res.on("close", () => {
        sessions.delete(transport.sessionId);
        void server.close().catch((error: unknown) => {
          log("warn", "sse_connection_close_failed", {
            error_class: errorClass(error),
          });
        });
      });
      await server.connect(transport);
    } catch (error) {
      log("error", "sse_request_failed", { error_class: errorClass(error) });
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, "Internal server error"));
      } else {
        res.end();
      }
    }
  });

  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId;
    const session =
      typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!session) {
      // The id is client-supplied; it is never echoed back or logged.
      res.status(400).json(jsonRpcError(-32000, "Unknown session"));
      return;
    }
    try {
      await session.transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      log("error", "sse_message_failed", { error_class: errorClass(error) });
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, "Internal server error"));
      } else {
        res.end();
      }
    }
  });
}
