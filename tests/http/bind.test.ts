/**
 * Where the `--http` listener binds (issue #11, confirmed finding from #20).
 *
 * `app.listen(port)` bound every interface, and the DNS-rebinding middleware
 * did not help: it validates the `Host` header, which the attacker writes. A
 * host on the same LAN sending `Host: localhost` got a 200 with full
 * `serverInfo`.
 *
 * The socket-level tests below do not take the bind address on trust from a
 * log line — they connect from a non-loopback address on this machine and
 * assert that the connection is *refused*, which is the only evidence that
 * matters.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as http from "node:http";
import { networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BIND_ADDRESS_ENV,
  DEFAULT_BIND_ADDRESS,
  isLoopbackAddress,
  resolveBindAddress,
} from "../../src/http/bind";
import { createMcpHttpApp } from "../../src/http/app";
import { initializeBody, NO_AUTH, SECURITY } from "./harness";

let server: http.Server | undefined;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (server) {
    const target = server;
    await new Promise<void>((resolve) => target.close(() => resolve()));
    target.closeAllConnections();
  }
  server = undefined;
  vi.restoreAllMocks();
});

/** A non-loopback IPv4 address of this machine, if it has one. */
function externalIPv4(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return undefined;
}

async function listen(address: string): Promise<number> {
  const app = createMcpHttpApp({
    auth: NO_AUTH,
    createServer: () => new McpServer({ name: "bind-test", version: "1.0.0" }),
    security: SECURITY,
  });
  const listening: http.Server = await new Promise((resolve) => {
    const started = app.listen(0, address, () => resolve(started));
  });
  server = listening;
  return (listening.address() as AddressInfo).port;
}

/**
 * Attempt a connection *from* `localAddress`, which is how a request from
 * another host arrives. A loopback-bound listener refuses it at the TCP layer.
 */
function probe(
  host: string,
  port: number,
  localAddress?: string
): Promise<{ status: number; body: string } | { error: string }> {
  return new Promise((resolve) => {
    const request = http.request(
      {
        host,
        port,
        localAddress,
        path: "/mcp",
        method: "POST",
        // The forged header that used to be enough.
        headers: {
          host: `localhost:${port}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        timeout: 2000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body })
        );
      }
    );
    request.on("timeout", () => {
      request.destroy();
      resolve({ error: "ETIMEDOUT" });
    });
    request.on("error", (error: NodeJS.ErrnoException) =>
      resolve({ error: error.code ?? error.message })
    );
    request.write(initializeBody());
    request.end();
  });
}

describe("resolveBindAddress", () => {
  it("defaults to loopback", () => {
    expect(resolveBindAddress({})).toBe(DEFAULT_BIND_ADDRESS);
    expect(DEFAULT_BIND_ADDRESS).toBe("127.0.0.1");
    // The bug: neither wildcard may ever be the default.
    expect(DEFAULT_BIND_ADDRESS).not.toBe("0.0.0.0");
    expect(DEFAULT_BIND_ADDRESS).not.toBe("::");
  });

  it("treats a blank value as unset", () => {
    expect(resolveBindAddress({ [BIND_ADDRESS_ENV]: "   " })).toBe(
      DEFAULT_BIND_ADDRESS
    );
  });

  it("honours an explicit opt-in", () => {
    expect(resolveBindAddress({ [BIND_ADDRESS_ENV]: "0.0.0.0" })).toBe(
      "0.0.0.0"
    );
  });

  it("warns — loudly and only — when the opt-in is not loopback", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    resolveBindAddress({ [BIND_ADDRESS_ENV]: "127.0.0.1" });
    expect(stderr.mock.calls).toHaveLength(0);

    resolveBindAddress({ [BIND_ADDRESS_ENV]: "0.0.0.0" });
    const record = JSON.parse(String(stderr.mock.calls[0][0]));
    expect(record.event).toBe("http_bind_not_loopback");
    expect(record.address).toBe("0.0.0.0");
  });

  it("recognizes the whole loopback block, and nothing outside it", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("[::1]")).toBe(true);
    expect(isLoopbackAddress("LocalHost")).toBe(true);
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("::")).toBe(false);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
    // Not a substring match: this is a public address.
    expect(isLoopbackAddress("127.0.0.1.evil.example")).toBe(false);
  });
});

describe("the listener really is where it says it is", () => {
  it("serves loopback callers on the default bind", async () => {
    const port = await listen(DEFAULT_BIND_ADDRESS);
    const result = await probe("127.0.0.1", port);
    expect(result).toMatchObject({ status: 200 });
  });

  it("refuses a caller arriving on an external interface", async () => {
    const external = externalIPv4();
    if (!external) {
      // No non-loopback IPv4 on this machine (a sandboxed CI runner); the
      // exploit this test reproduces is not reachable here either.
      return;
    }

    const port = await listen(DEFAULT_BIND_ADDRESS);
    // Exactly the #20 exploit: connect to the machine's LAN address, forge
    // `Host: localhost`. Before this change it answered 200 with serverInfo.
    const result = await probe(external, port);
    expect(result).not.toMatchObject({ status: 200 });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(
      /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/
    );
  });

  it("reaches the external interface once the opt-in is set", async () => {
    const external = externalIPv4();
    if (!external) return;

    const port = await listen("0.0.0.0");
    const result = await probe(external, port);
    // The opt-in genuinely changes the binding — otherwise the previous test
    // would pass for the wrong reason (e.g. a firewall doing the work).
    expect(result).toMatchObject({ status: 200 });
  });
});
