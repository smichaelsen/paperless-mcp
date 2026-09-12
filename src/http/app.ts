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
 *
 * ## Every route is authenticated
 *
 * `bearerAuth` is applied app-wide rather than per route, so a route added
 * later is protected by default rather than by remembering to protect it. The
 * only exemptions are the container probe paths in
 * `UNAUTHENTICATED_PATHS` (issue #10), which nothing here serves yet.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Express, Request, Response } from "express";
import type { HttpAuthConfig } from "../config/httpAuth";
import { errorClass, log } from "../logging";
import { bearerAuth } from "./auth";
import { HealthOptions, registerHealthRoutes } from "./health";
import { registerLegacySseRoutes } from "./legacySse";
import {
  bodyLimitErrorHandler,
  HttpLimitsConfig,
  rateLimit,
  resolveHttpLimits,
} from "./limits";
import {
  dnsRebindingProtection,
  HttpSecurityConfig,
  resolveHttpSecurity,
} from "./security";

/** Builds a fully registered, *unconnected* MCP server. Called per connection. */
export type McpServerFactory = () => McpServer;

export interface McpHttpAppOptions {
  createServer: McpServerFactory;
  /**
   * Required, not optional-with-a-default: an app built without a deliberate
   * decision about authentication would be an unauthenticated app, and the
   * one place allowed to decide "disabled" is `resolveHttpAuth`, which makes
   * the operator say so explicitly.
   */
  auth: HttpAuthConfig;
  security?: HttpSecurityConfig;
  limits?: HttpLimitsConfig;
  /** Container/orchestrator probes. See `health.ts` for what they may say. */
  health?: HealthOptions;
  /**
   * Legacy `GET /sse` + `POST /messages` routes. **Off unless explicitly
   * enabled**: they are the least-exercised surface here, the SDK deprecates
   * them in favour of Streamable HTTP, and their session table is the only
   * cross-request state this server would otherwise hold.
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
  const limits = options.limits ?? resolveHttpLimits(process.env);

  const app = express();
  // Express's `X-Powered-By` announces the stack to anyone probing the port.
  app.disable("x-powered-by");
  // Ordering is the security-relevant part of this function:
  //
  // 1. Host/Origin — the cheapest check, and the one that stops a browser page
  //    from reaching any of the following at all.
  // 2. Rate limit — before authentication, so the bearer secret cannot be
  //    guessed at line rate.
  // 3. Authentication — before the body parser, so an unauthenticated caller
  //    can never make this process buffer and parse a 10 MB body.
  // 4. Body parsing, and only then a transport.
  app.use(dnsRebindingProtection(security));
  app.use(
    rateLimit({ max: limits.rateLimitMax, windowMs: limits.rateLimitWindowMs })
  );
  app.use(bearerAuth(options.auth));
  app.use(express.json({ limit: limits.maxBody }));
  // Registered immediately after the parser it translates, so an oversized or
  // unparseable body gets the JSON-RPC shape rather than Express's HTML page.
  app.use(bodyLimitErrorHandler());
  // Registered after every app-wide middleware, which is what keeps the
  // container probes inside the Host/Origin and rate-limit boundaries. Only
  // `bearerAuth` lets them through, and only by the explicit path exemption in
  // `UNAUTHENTICATED_PATHS`.
  registerHealthRoutes(app, options.health);

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
      // No transport-level Host/Origin options: `dnsRebindingProtection` above
      // is the single enforcement point. See the note in security.ts.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
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

  if (options.enableLegacySse === true) {
    registerLegacySseRoutes(app, { createServer });
  }

  return app;
}
