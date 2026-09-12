#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaperlessAPI } from "./api/PaperlessAPI";
import {
  resolvePaperlessToken,
  TOKEN_ENV,
  TOKEN_FILE_ENV,
} from "./config/credentials";
import {
  ALLOW_UNAUTHENTICATED_ENV,
  describeAuth,
  resolveHttpAuth,
} from "./config/httpAuth";
import { resolveToolAccess } from "./config/toolAccess";
import { createMcpHttpApp } from "./http/app";
import {
  BIND_ADDRESS_ENV,
  isLoopbackAddress,
  resolveBindAddress,
} from "./http/bind";
import { resolveHttpLimits } from "./http/limits";
import { installProcessErrorHandlers } from "./http/processErrors";
import { describeAllowlist, resolveHttpSecurity } from "./http/security";
import { ENABLE_LEGACY_SSE_ENV, legacySseEnabled } from "./http/legacyFlag";
import { log, logFatal, registerSecret } from "./logging";
import { registerAllTools } from "./mcp/registerTools";

// Simple CLI argument parsing
const args = process.argv.slice(2);
const useHttp = args.includes("--http");
let port = 3000;
const portIndex = args.indexOf("--port");
if (portIndex !== -1 && args[portIndex + 1]) {
  const parsed = parseInt(args[portIndex + 1], 10);
  if (!isNaN(parsed)) port = parsed;
}

async function main() {
  installProcessErrorHandlers();

  let baseUrl: string | undefined;
  let token: string | undefined;

  const envHint = `PAPERLESS_URL and ${TOKEN_ENV} (or ${TOKEN_FILE_ENV}) environment variables must be set.`;

  if (useHttp) {
    baseUrl = process.env.PAPERLESS_URL;
    token = resolvePaperlessToken(process.env)?.value;
    if (!baseUrl || !token) {
      console.error(`When using --http, ${envHint}`);
      process.exit(1);
    }
  } else {
    // A flag is never a positional value. Without this, `paperless-mcp
    // --allow-writes` with credentials in the environment would take the flag
    // as the base URL, discard PAPERLESS_URL, pass the usage check below, and
    // then fail every single request with an ERR_INVALID_URL only visible in
    // stderr. The value after `--port` is skipped with it.
    const positional = args.filter(
      (arg, index) =>
        !arg.startsWith("--") && !(index > 0 && args[index - 1] === "--port")
    );
    baseUrl = positional[0] || process.env.PAPERLESS_URL;
    // Resolved lazily: a positional token wins, and `||` short-circuits, so a
    // stale or unmounted PAPERLESS_API_TOKEN_FILE in the environment cannot
    // break the documented `paperless-mcp <baseUrl> <token>` form.
    token = positional[1] || resolvePaperlessToken(process.env)?.value;
    if (!baseUrl || !token) {
      console.error(
        "Usage: paperless-mcp <baseUrl> <token> [--http] [--port <port>] [--allow-writes] [--allow-destructive]"
      );
      console.error(
        "Example: paperless-mcp http://localhost:8000 your-api-token --http --port 3000"
      );
      console.error(`Alternatively, ${envHint}`);
      process.exit(1);
    }
  }

  registerSecret(token);

  // The API client is stateless and safe to share: it holds a base URL and a
  // token and keeps no per-client state. The MCP server is not — it stores the
  // transport it is connected to — so it is built per connection instead.
  const api = new PaperlessAPI(baseUrl, token);
  // Resolved once, not per connection: the access mode cannot change while the
  // process runs, and re-resolving it would repeat its warnings on every
  // request.
  const toolAccess = resolveToolAccess();
  // The advertised surface is identical for every connection, so it is logged
  // once per process rather than from inside registration — which under `--http`
  // runs per request and would repeat this line on every one. Under `--http`
  // that means the line lands on the first connection, not at listen time,
  // because no server exists until then. The flag is scoped to this `main()`
  // call; moving `createServer` out of it would need the flag to move too.
  let modeLogged = false;
  const createServer = (): McpServer => {
    const server = new McpServer({ name: "paperless-ngx", version: "1.0.0" });
    const registered = registerAllTools(server, api, toolAccess);
    if (!modeLogged) {
      modeLogged = true;
      log("info", "tool_access_mode", {
        mode: toolAccess.label,
        writes: toolAccess.writes,
        destructive: toolAccess.destructive,
        tools: registered.length,
      });
    }
    return server;
  };

  if (useHttp) {
    const security = resolveHttpSecurity(process.env);
    const limits = resolveHttpLimits(process.env);
    const bindAddress = resolveBindAddress(process.env);
    // Throws a CredentialError — caught and logged by main().catch — when no
    // secret is configured and the opt-out was not set. Deliberately fatal;
    // see the reasoning on resolveHttpAuth.
    const auth = resolveHttpAuth(process.env);
    const enableLegacySse = legacySseEnabled(process.env);

    // Unauthenticated *and* reachable from the network is the exact
    // combination that made this listener a remote Paperless proxy. The
    // escape hatch exists for local development; it does not extend to
    // publishing the port.
    if (auth.mode === "disabled" && !isLoopbackAddress(bindAddress)) {
      logFatal(
        new Error(
          `Refusing to start: ${ALLOW_UNAUTHENTICATED_ENV} is set while ` +
            `${BIND_ADDRESS_ENV} binds a non-loopback address. Configure an ` +
            `authentication secret, or bind loopback only.`
        )
      );
      process.exit(1);
    }

    const app = createMcpHttpApp({
      createServer,
      auth,
      security,
      limits,
      enableLegacySse,
    });
    app.listen(port, bindAddress, () => {
      // stderr via log(): stdout is the MCP framing channel under stdio.
      log("info", "http_server_listening", {
        address: bindAddress,
        port,
        transport: "streamable-http",
        session_mode: "stateless",
        // The mode and the variable it came from, never the secret itself.
        auth: describeAuth(auth),
        legacy_sse: enableLegacySse ? ENABLE_LEGACY_SSE_ENV : "disabled",
        max_body: limits.maxBody,
        rate_limit:
          limits.rateLimitMax > 0
            ? `${limits.rateLimitMax}/${limits.rateLimitWindowMs}ms`
            : "disabled",
        allowed_hosts: describeAllowlist(security.allowedHosts),
        allowed_origins: describeAllowlist(security.allowedOrigins),
      });
    });
  } else {
    const transport = new StdioServerTransport();
    await createServer().connect(transport);
  }
}

main().catch((e) => {
  // Never print the raw error: its message may embed a credential-bearing URL.
  logFatal(e);
  process.exitCode = 1;
});
