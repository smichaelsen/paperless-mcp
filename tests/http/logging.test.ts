/**
 * Logging gaps the HTTP block carried until #14 (see issue #19, part 1):
 * raw error objects on `console.error`, a `console.log` on **stdout** — the MCP
 * framing channel under stdio — and no handler for an escaping rejection.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpHttpApp } from "../../src/http/app";
import {
  installProcessErrorHandlers,
  logUncaughtException,
  logUnhandledRejection,
} from "../../src/http/processErrors";
import { DEFAULT_ALLOWED_HOSTS } from "../../src/http/security";
import { clearRegisteredSecrets, registerSecret } from "../../src/logging";
import { connectClient, initializeBody, rawRequest, RunningApp, startApp } from "./harness";

const SECURITY = {
  allowedHosts: DEFAULT_ALLOWED_HOSTS,
  allowedOrigins: [] as string[],
};

const TOKEN = "paperless-token-abcdef123456";
const LEAKY_MESSAGE = `connect ECONNREFUSED https://admin:${TOKEN}@paperless.example/api/?token=${TOKEN}`;

let running: RunningApp | undefined;
let stderr: ReturnType<typeof vi.spyOn>;
let stdout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearRegisteredSecrets();
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  if (running) await running.close();
  running = undefined;
  clearRegisteredSecrets();
  vi.restoreAllMocks();
});

function stderrLines(): string[] {
  return stderr.mock.calls.map((call) => String(call[0]));
}

function stdoutWrites(): string[] {
  return stdout.mock.calls.map((call) => String(call[0]));
}

describe("HTTP transport logging", () => {
  it("writes nothing to stdout across a full request lifecycle", async () => {
    running = await startApp(
      createMcpHttpApp({
        createServer: () => {
          const server = new McpServer({ name: "log-test", version: "1.0.0" });
          server.registerTool(
            "ping",
            { description: "ping", inputSchema: {} },
            async () => ({ content: [{ type: "text" as const, text: "pong" }] })
          );
          return server;
        },
        security: SECURITY,
      })
    );

    const client = await connectClient(running.url, "client-a");
    await client.listTools();
    await client.callTool({ name: "ping", arguments: {} });
    await client.close();

    // The legacy SSE route used to `console.log("SSE request received")`.
    const sseClient = new Client({ name: "sse-a", version: "1.0.0" });
    await sseClient.connect(
      new SSEClientTransport(new URL(`${running.url}/sse`))
    );
    await sseClient.close();

    expect(stdoutWrites()).toEqual([]);
    expect(
      stderrLines().some((line) => line.indexOf("sse_connection_opening") !== -1)
    ).toBe(true);
  });

  it("logs a failing request as redacted JSON, never as a raw error", async () => {
    registerSecret(TOKEN);
    running = await startApp(
      createMcpHttpApp({
        createServer: () => {
          // Stands in for anything that can throw while a request is being set
          // up; its message carries a credential the way a fetch failure does.
          throw new Error(LEAKY_MESSAGE);
        },
        security: SECURITY,
      })
    );

    const response = await rawRequest({
      port: running.port,
      path: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });

    expect(response.status).toBe(500);
    const lines = stderrLines();
    const failure = lines.find(
      (line) => line.indexOf("mcp_request_failed") !== -1
    );
    expect(failure).toBeDefined();
    expect(JSON.parse(failure!)).toEqual({
      level: "error",
      event: "mcp_request_failed",
      error_class: "Error",
    });

    // Nothing anywhere on either stream may carry the credential, and every
    // stderr line must be a structured record rather than an Error object.
    for (const line of lines.concat(stdoutWrites())) {
      expect(line).not.toContain(TOKEN);
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(response.body).not.toContain(TOKEN);
  });
});

describe("process-level error handlers", () => {
  it("logs an unhandled rejection as a redacted record", () => {
    registerSecret(TOKEN);
    logUnhandledRejection(new Error(LEAKY_MESSAGE));

    const record = JSON.parse(stderrLines()[0]);
    expect(record.level).toBe("error");
    expect(record.event).toBe("unhandled_rejection");
    expect(record.error_class).toBe("Error");
    expect(record.message).not.toContain(TOKEN);
    expect(record.message).toContain("[redacted]");
  });

  it("caps the logged message the way logFatal does", () => {
    logUnhandledRejection(new Error("x".repeat(5000)));
    const record = JSON.parse(stderrLines()[0]);
    expect(record.message).toHaveLength(200);
  });

  it("classifies a non-Error rejection without printing it", () => {
    logUncaughtException({ toString: () => "weird" });
    const record = JSON.parse(stderrLines()[0]);
    expect(record.event).toBe("uncaught_exception");
    expect(record.error_class).toBe("object");
  });

  it("installs handlers that survive a rejection and exit on an exception", () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    const uninstall = installProcessErrorHandlers(target, { exit });

    target.emit("unhandledRejection", new Error("rejected"));
    expect(exit).not.toHaveBeenCalled();
    expect(stderrLines()[0]).toContain("unhandled_rejection");

    target.emit("uncaughtException", new Error("fatal"));
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderrLines()[1]).toContain("uncaught_exception");

    uninstall();
    expect(target.listenerCount("unhandledRejection")).toBe(0);
    expect(target.listenerCount("uncaughtException")).toBe(0);
  });
});
