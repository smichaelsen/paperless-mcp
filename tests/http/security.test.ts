/**
 * DNS-rebinding / Host / Origin protection for the `--http` transport.
 *
 * Without it, any web page can drive a localhost MCP server that holds a
 * Paperless API token.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpHttpApp } from "../../src/http/app";
import {
  ALLOWED_HOSTS_ENV,
  ALLOWED_ORIGINS_ENV,
  DEFAULT_ALLOWED_HOSTS,
  describeAllowlist,
  hostnameOf,
  resolveHttpSecurity,
  transportSecurityOptions,
} from "../../src/http/security";
import { initializeBody, rawRequest, RunningApp, startApp } from "./harness";

describe("resolveHttpSecurity", () => {
  it("defaults to loopback hosts and no browser origin", () => {
    const config = resolveHttpSecurity({});
    expect(config.allowedHosts).toEqual(DEFAULT_ALLOWED_HOSTS);
    expect(config.allowedOrigins).toEqual([]);
  });

  it("reads comma-separated allowlists from the environment", () => {
    const config = resolveHttpSecurity({
      [ALLOWED_HOSTS_ENV]: " paperless-mcp , Mcp.Example ",
      [ALLOWED_ORIGINS_ENV]: "https://app.example",
    });
    expect(config.allowedHosts).toEqual(["paperless-mcp", "mcp.example"]);
    expect(config.allowedOrigins).toEqual(["https://app.example"]);
  });

  it("treats a blank value as unset", () => {
    const config = resolveHttpSecurity({
      [ALLOWED_HOSTS_ENV]: "  ,  ",
    });
    expect(config.allowedHosts).toEqual(DEFAULT_ALLOWED_HOSTS);
  });

  it("disables a check only when '*' is listed explicitly", () => {
    const config = resolveHttpSecurity({
      [ALLOWED_HOSTS_ENV]: "localhost,*",
      [ALLOWED_ORIGINS_ENV]: "*",
    });
    expect(config.allowedHosts).toBe("any");
    expect(config.allowedOrigins).toBe("any");
    expect(describeAllowlist(config.allowedHosts)).toBe("*");
  });

  it("strips the port when matching a Host header", () => {
    expect(hostnameOf("localhost:3000")).toBe("localhost");
    expect(hostnameOf("[::1]:3000")).toBe("[::1]");
    expect(hostnameOf("127.0.0.1")).toBe("127.0.0.1");
    expect(hostnameOf("not a host")).toBeUndefined();
  });

  it("hands configured origins down to the transport as defence in depth", () => {
    expect(
      transportSecurityOptions({
        allowedHosts: DEFAULT_ALLOWED_HOSTS,
        allowedOrigins: ["https://app.example"],
      })
    ).toEqual({
      enableDnsRebindingProtection: true,
      allowedOrigins: ["https://app.example"],
    });
    // Nothing to enforce when every origin is rejected outright, or none is.
    expect(
      transportSecurityOptions({
        allowedHosts: "any",
        allowedOrigins: [],
      })
    ).toEqual({});
  });
});

describe("dnsRebindingProtection over HTTP", () => {
  let running: RunningApp | undefined;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    if (running) await running.close();
    running = undefined;
    vi.restoreAllMocks();
  });

  async function serve(env: Record<string, string | undefined> = {}) {
    running = await startApp(
      createMcpHttpApp({
        createServer: () =>
          new McpServer({ name: "security-test", version: "1.0.0" }),
        security: resolveHttpSecurity(env),
      })
    );
    return running;
  }

  const jsonHeaders = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  it("accepts a loopback Host by default", async () => {
    const app = await serve();
    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: { ...jsonHeaders, host: `localhost:${app.port}` },
      body: initializeBody(),
    });
    expect(response.status).toBe(200);
  });

  it("rejects a rebound Host with 403 before reaching the transport", async () => {
    const app = await serve();
    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: { ...jsonHeaders, host: "attacker.example" },
      body: initializeBody(),
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain(ALLOWED_HOSTS_ENV);
    // The rejected value is attacker-controlled: it must not be echoed back.
    expect(response.body).not.toContain("attacker.example");
  });

  it("rejects any browser Origin by default", async () => {
    const app = await serve();
    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: {
        ...jsonHeaders,
        host: `127.0.0.1:${app.port}`,
        origin: "https://evil.example",
      },
      body: initializeBody(),
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain(ALLOWED_ORIGINS_ENV);
  });

  it("accepts a configured Origin", async () => {
    const app = await serve({
      [ALLOWED_ORIGINS_ENV]: "https://app.example",
    });
    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: {
        ...jsonHeaders,
        host: `127.0.0.1:${app.port}`,
        origin: "https://app.example",
      },
      body: initializeBody(),
    });
    expect(response.status).toBe(200);
  });

  it("accepts a configured non-loopback Host", async () => {
    const app = await serve({ [ALLOWED_HOSTS_ENV]: "paperless-mcp" });
    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: { ...jsonHeaders, host: `paperless-mcp:${app.port}` },
      body: initializeBody(),
    });
    expect(response.status).toBe(200);
  });

  it("protects the legacy SSE routes too", async () => {
    const app = await serve();
    const sse = await rawRequest({
      port: app.port,
      path: "/sse",
      method: "GET",
      headers: { host: "attacker.example", accept: "text/event-stream" },
    });
    expect(sse.status).toBe(403);

    const messages = await rawRequest({
      port: app.port,
      path: "/messages?sessionId=whatever",
      headers: { ...jsonHeaders, host: "attacker.example" },
      body: "{}",
    });
    expect(messages.status).toBe(403);
  });

  it("logs a rejection without the offending header value", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await serve();
    await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: { ...jsonHeaders, host: "attacker.example" },
      body: initializeBody(),
    });

    const lines = stderr.mock.calls.map((call) => String(call[0]));
    const rejection = lines.find(
      (line) => line.indexOf("http_request_rejected") !== -1
    );
    expect(rejection).toBeDefined();
    expect(JSON.parse(rejection!)).toEqual({
      level: "warn",
      event: "http_request_rejected",
      reason: "host_not_allowed",
    });
    expect(rejection).not.toContain("attacker.example");
  });
});
