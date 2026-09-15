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
import {
  resolveConfiguredToolAllowlists,
  TOOL_ALLOWLIST_VALUE_FLAGS,
} from "./config/toolAllowlist";
import { resolveToolAccess } from "./config/toolAccess";
import { logEffectiveToolPolicy } from "./config/toolPolicyLog";
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
import { resolveEffectiveToolPolicy } from "./mcp/toolPolicy";

// Simple CLI argument parsing
const args = process.argv.slice(2);
const useHttp = args.includes("--http");
let port = 3000;
const portIndex = args.indexOf("--port");
if (portIndex !== -1 && args[portIndex + 1]) {
  const parsed = parseInt(args[portIndex + 1], 10);
  if (!isNaN(parsed)) port = parsed;
}

/**
 * Advertised in the `initialize` response as `serverInfo`. The version is a
 * literal rather than a read of `package.json`: importing a file from outside
 * `src/` would pull it into the TypeScript root and move the compiled
 * entrypoint off `build/index.js`, which is the `paperless-mcp` bin.
 *
 * It therefore has to be bumped alongside `package.json` by hand — see
 * RELEASING.md. `tests/serverInfo.test.ts` fails if the two ever disagree.
 */
const SERVER_NAME = "paperless-ngx";
const SERVER_VERSION = "0.1.1";

async function main() {
  installProcessErrorHandlers();

  // Resolve and validate the complete tool policy before constructing a
  // transport. Invalid allowlists therefore fail startup rather than waiting
  // for the first HTTP client to connect.
  const toolAccess = resolveToolAccess(process.env, args);
  const toolPolicy = resolveEffectiveToolPolicy(
    toolAccess,
    resolveConfiguredToolAllowlists(process.env, args)
  );

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
    // stderr. Values belonging to `--port` or either allowlist flag are skipped
    // with their flags.
    const valueFlags = new Set(["--port", ...TOOL_ALLOWLIST_VALUE_FLAGS]);
    const positional = args.filter(
      (arg, index) =>
        !arg.startsWith("--") &&
        !(index > 0 && valueFlags.has(args[index - 1]))
    );
    baseUrl = positional[0] || process.env.PAPERLESS_URL;
    // Resolved lazily: a positional token wins, and `||` short-circuits, so a
    // stale or unmounted PAPERLESS_API_TOKEN_FILE in the environment cannot
    // break the documented `paperless-mcp <baseUrl> <token>` form.
    token = positional[1] || resolvePaperlessToken(process.env)?.value;
    if (!baseUrl || !token) {
      console.error(
        "Usage: paperless-mcp <baseUrl> <token> [--http] [--port <port>] [--allow-writes] [--allow-destructive] [--enabled-tools <names>] [--bulk-edit-methods <names>]"
      );
      console.error(
        "Example: paperless-mcp http://localhost:8000 your-api-token --http --port 3000"
      );
      console.error(`Alternatively, ${envHint}`);
      process.exit(1);
    }
  }

  registerSecret(token);

  logEffectiveToolPolicy(toolPolicy);

  // The API client is stateless and safe to share: it holds a base URL and a
  // token and keeps no per-client state. The MCP server is not — it stores the
  // transport it is connected to — so it is built per connection instead.
  const api = new PaperlessAPI(baseUrl, token);
  const createServer = (): McpServer => {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerAllTools(server, api, toolPolicy);
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
      // Readiness asks Paperless an authenticated question available to every
      // active account and reports only whether it answered. The probe stays on
      // PaperlessAPI so it uses the same version negotiation as tool requests;
      // `health.ts` never sees the base URL or token and cannot leak either
      // into an unauthenticated response.
      health: { probeUpstream: (signal) => api.probeReadiness(signal) },
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
