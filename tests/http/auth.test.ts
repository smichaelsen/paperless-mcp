/**
 * Authentication on the `--http` transport (issue #11).
 *
 * The acceptance criterion is a matrix: **missing, malformed, wrong and
 * correct** credentials on **every enabled route**. `ROUTES` below is that
 * matrix's second axis, and the four cases are driven over it as a table, so a
 * route added without an auth decision cannot quietly escape coverage.
 *
 * The end-to-end half uses a real MCP client over a real socket: a 401 that
 * still let `initialize` through would be a worthless 401.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ALLOW_UNAUTHENTICATED_ENV,
  AUTH_TOKEN_ENV,
  AUTH_TOKEN_FILE_ENV,
  UNAUTHENTICATED_METHODS,
  UNAUTHENTICATED_PATHS,
  bearerCredential,
  describeAuth,
  HttpAuthConfig,
  resolveHttpAuth,
  secretsMatch,
} from "../../src/config/httpAuth";
import { createMcpHttpApp } from "../../src/http/app";
import { announcesBody, isPublicRequest } from "../../src/http/auth";
import { logUnhandledRejection } from "../../src/http/processErrors";
import { clearRegisteredSecrets, logFatal } from "../../src/logging";
import {
  connectClient,
  initializeBody,
  NO_AUTH,
  rawRequest,
  RunningApp,
  SECURITY,
  startApp,
} from "./harness";

const SECRET = "s3cret-bearer-value-9f2a1c";

const jsonHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

let running: RunningApp | undefined;
let tempDir: string | undefined;

beforeEach(() => {
  clearRegisteredSecrets();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (running) await running.close();
  running = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  clearRegisteredSecrets();
  vi.restoreAllMocks();
});

function testServer(): McpServer {
  const server = new McpServer({ name: "auth-test", version: "1.0.0" });
  server.registerTool(
    "echo",
    { description: "echo", inputSchema: { value: z.string() } },
    async ({ value }: { value: string }) => ({
      content: [{ type: "text" as const, text: value }],
    })
  );
  return server;
}

async function serve(
  auth: HttpAuthConfig,
  enableLegacySse = false
): Promise<RunningApp> {
  running = await startApp(
    createMcpHttpApp({
      auth,
      createServer: testServer,
      security: SECURITY,
      enableLegacySse,
    })
  );
  return running;
}

const BEARER: HttpAuthConfig = {
  mode: "bearer",
  secret: SECRET,
  source: AUTH_TOKEN_ENV,
};

/**
 * Every route the app can serve, with a request that would *succeed* if the
 * caller were authenticated — so a 401 is provably the auth middleware and not
 * the route being absent or the method being wrong.
 */
const ROUTES: {
  name: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  /** Status this request gets when the credential is correct. */
  authorized: number;
  legacy?: boolean;
}[] = [
  {
    name: "POST /mcp",
    method: "POST",
    path: "/mcp",
    headers: jsonHeaders,
    body: initializeBody(),
    authorized: 200,
  },
  {
    name: "GET /mcp",
    method: "GET",
    path: "/mcp",
    headers: jsonHeaders,
    // Stateless mode: 405 is the authenticated answer, not 401.
    authorized: 405,
  },
  {
    name: "DELETE /mcp",
    method: "DELETE",
    path: "/mcp",
    headers: jsonHeaders,
    authorized: 405,
  },
  {
    name: "POST /messages",
    method: "POST",
    path: "/messages?sessionId=whatever",
    headers: jsonHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    // No such session, but only an authenticated caller gets to find out.
    authorized: 400,
    legacy: true,
  },
];

/** The four credential cases of the acceptance criterion. */
const CREDENTIALS: { name: string; headers: Record<string, string> }[] = [
  { name: "missing", headers: {} },
  { name: "malformed (no scheme)", headers: { authorization: SECRET } },
  {
    name: "malformed (wrong scheme)",
    headers: { authorization: `Basic ${SECRET}` },
  },
  { name: "malformed (empty credential)", headers: { authorization: "Bearer" } },
  {
    name: "malformed (scheme only, trailing space)",
    headers: { authorization: "Bearer " },
  },
  { name: "wrong", headers: { authorization: "Bearer not-the-secret" } },
  {
    name: "wrong (right length, one byte off)",
    headers: { authorization: `Bearer ${SECRET.slice(0, -1)}X` },
  },
  {
    name: "wrong (correct secret as a prefix)",
    headers: { authorization: `Bearer ${SECRET}extra` },
  },
];

describe("bearer authentication on every enabled route", () => {
  for (const route of ROUTES) {
    describe(route.name, () => {
      for (const credential of CREDENTIALS) {
        it(`rejects ${credential.name} credentials with 401`, async () => {
          const app = await serve(BEARER, route.legacy === true);
          const response = await rawRequest({
            port: app.port,
            path: route.path,
            method: route.method,
            headers: {
              ...route.headers,
              ...credential.headers,
              host: `127.0.0.1:${app.port}`,
            },
            body: route.body,
          });

          expect(response.status).toBe(401);
          expect(response.headers["www-authenticate"]).toBe("Bearer");
          // Identical body for every failure: nothing distinguishes malformed
          // from wrong, and the secret is never echoed back.
          expect(JSON.parse(response.body)).toEqual({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Unauthorized" },
            id: null,
          });
          expect(response.body).not.toContain(SECRET);
        });
      }

      it("accepts the correct credential", async () => {
        const app = await serve(BEARER, route.legacy === true);
        const response = await rawRequest({
          port: app.port,
          path: route.path,
          method: route.method,
          headers: {
            ...route.headers,
            authorization: `Bearer ${SECRET}`,
            host: `127.0.0.1:${app.port}`,
          },
          body: route.body,
        });

        expect(response.status).toBe(route.authorized);
      });
    });
  }

  it("accepts the scheme case-insensitively, per RFC 9110", async () => {
    const app = await serve(BEARER);
    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: {
        ...jsonHeaders,
        authorization: `bEaReR ${SECRET}`,
        host: `127.0.0.1:${app.port}`,
      },
      body: initializeBody(),
    });
    expect(response.status).toBe(200);
  });

  it("gates GET /sse before the stream opens", async () => {
    // SSE needs its own case: the route never sends a JSON body, so a 401 has
    // to arrive instead of the event stream rather than inside it.
    const app = await serve(BEARER, true);
    const unauthorized = await rawRequest({
      port: app.port,
      path: "/sse",
      method: "GET",
      headers: { accept: "text/event-stream", host: `127.0.0.1:${app.port}` },
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).not.toContain("event: endpoint");

    const client = new Client({ name: "sse-auth", version: "1.0.0" });
    await client.connect(
      new SSEClientTransport(new URL(`${app.url}/sse`), {
        requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
        eventSourceInit: {
          fetch: (url: string | URL | Request, init?: RequestInit) =>
            fetch(url, {
              ...init,
              headers: {
                ...(init?.headers as Record<string, string> | undefined),
                authorization: `Bearer ${SECRET}`,
              },
            }),
        },
      })
    );
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("echo");
    await client.close();
  });
});

describe("what an unauthenticated caller can actually do", () => {
  it("cannot initialize MCP", async () => {
    const app = await serve(BEARER);
    const client = new Client({ name: "anon", version: "1.0.0" });
    await expect(
      client.connect(
        new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`))
      )
    ).rejects.toThrow();
  });

  it("cannot invoke a tool, even with a forged initialized session", async () => {
    const app = await serve(BEARER);
    // Skipping `initialize` entirely: stateless Streamable HTTP means a bare
    // `tools/call` is otherwise a perfectly serviceable request.
    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "echo", arguments: { value: "leaked" } },
      }),
    });

    expect(response.status).toBe(401);
    expect(response.body).not.toContain("leaked");
  });

  it("learns nothing about the server from the rejection", async () => {
    const app = await serve(BEARER);
    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
      body: initializeBody(),
    });
    // No serverInfo, no tool names, no version, no Express fingerprint.
    expect(response.body).not.toContain("auth-test");
    expect(response.body).not.toContain("echo");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("an authenticated Streamable HTTP client, end to end", () => {
  it("initializes, lists tools and calls one", async () => {
    const app = await serve(BEARER);
    const client = await connectClient(app.url, "authorized", SECRET);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["echo"]);

    const result = await client.callTool({
      name: "echo",
      arguments: { value: "round-trip" },
    });
    expect((result as { content: { text: string }[] }).content[0].text).toBe(
      "round-trip"
    );

    await client.close();
  });
});

describe("the Host/Origin check and the auth check compose", () => {
  it("answers a forged Host with 403 before authentication is considered", async () => {
    // Deliberate ordering: the cheapest check first, and a browser page never
    // reaches the credential path at all. The 403 also reveals nothing about
    // the secret — it names the Host variable, which is configuration.
    const app = await serve(BEARER);
    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: {
        ...jsonHeaders,
        host: "attacker.example",
        authorization: `Bearer ${SECRET}`,
      },
      body: initializeBody(),
    });
    expect(response.status).toBe(403);
  });

  it("still requires the credential once the Host is allowed", async () => {
    const app = await serve(BEARER);
    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: { ...jsonHeaders, host: `localhost:${app.port}` },
      body: initializeBody(),
    });
    expect(response.status).toBe(401);
  });
});

describe("resolveHttpAuth", () => {
  function withTempFile(contents: string): string {
    tempDir = mkdtempSync(join(tmpdir(), "paperless-mcp-auth-"));
    const path = join(tempDir, "secret");
    writeFileSync(path, contents);
    return path;
  }

  it("refuses to start when nothing is configured", () => {
    // The decision of issue #11: fail closed. An operator gets one actionable
    // error naming the variable, rather than a warning under a live listener.
    expect(() => resolveHttpAuth({})).toThrow(
      /requires an authentication secret/
    );
    expect(() => resolveHttpAuth({})).toThrow(AUTH_TOKEN_FILE_ENV);
    expect(() => resolveHttpAuth({})).toThrow(ALLOW_UNAUTHENTICATED_ENV);

    // The message an operator actually sees goes through `redact()` and a
    // 200-character cap. It must arrive whole and legible — an earlier
    // wording said "bearer secret", which the redactor replaced with
    // "[redacted]" because `Bearer <word>` is a credential shape.
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      resolveHttpAuth({});
    } catch (error) {
      logFatal(error);
    }
    const record = JSON.parse(String(stderr.mock.calls.at(-1)?.[0]));
    expect(record.message).not.toContain("[redacted]");
    expect(record.message).toContain(AUTH_TOKEN_FILE_ENV);
    expect(record.message).toContain(ALLOW_UNAUTHENTICATED_ENV);
    expect(record.message.length).toBeLessThan(200);
  });

  it("reads a file-backed secret and strips the trailing newline", () => {
    const path = withTempFile(`${SECRET}\n`);
    const auth = resolveHttpAuth({ [AUTH_TOKEN_FILE_ENV]: path });
    expect(auth).toEqual({
      mode: "bearer",
      secret: SECRET,
      source: AUTH_TOKEN_FILE_ENV,
    });
  });

  it("prefers the file over the inline variable", () => {
    const path = withTempFile(SECRET);
    const auth = resolveHttpAuth({
      [AUTH_TOKEN_FILE_ENV]: path,
      [AUTH_TOKEN_ENV]: "ignored-inline-value",
    });
    expect(auth).toEqual({
      mode: "bearer",
      secret: SECRET,
      source: AUTH_TOKEN_FILE_ENV,
    });
  });

  it("accepts the inline variable on its own", () => {
    expect(resolveHttpAuth({ [AUTH_TOKEN_ENV]: ` ${SECRET} ` })).toEqual({
      mode: "bearer",
      secret: SECRET,
      source: AUTH_TOKEN_ENV,
    });
  });

  it("fails loudly when the secret file is unreadable or empty", () => {
    expect(() =>
      resolveHttpAuth({ [AUTH_TOKEN_FILE_ENV]: "/nonexistent/secret" })
    ).toThrow(/Cannot read/);
    const empty = withTempFile("   \n");
    expect(() => resolveHttpAuth({ [AUTH_TOKEN_FILE_ENV]: empty })).toThrow(
      /is empty/
    );
  });

  it("disables authentication only on the explicit opt-out", () => {
    expect(
      resolveHttpAuth({ [ALLOW_UNAUTHENTICATED_ENV]: "true" })
    ).toEqual({ mode: "disabled" });
    // A typo is not an opt-out.
    expect(() =>
      resolveHttpAuth({ [ALLOW_UNAUTHENTICATED_ENV]: "ture" })
    ).toThrow();
  });

  it("never puts the secret in the startup description", () => {
    const auth = resolveHttpAuth({ [AUTH_TOKEN_ENV]: SECRET });
    expect(describeAuth(auth)).toBe(`bearer (${AUTH_TOKEN_ENV})`);
    expect(describeAuth(auth)).not.toContain(SECRET);
    expect(describeAuth({ mode: "disabled" })).toBe("disabled");
  });

  it("warns about a short secret without printing it", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    resolveHttpAuth({ [AUTH_TOKEN_ENV]: "hunter2" });
    const lines = stderr.mock.calls.map((call) => String(call[0]));
    const warning = lines.find(
      (line) => line.indexOf("http_auth_secret_short") !== -1
    );
    expect(warning).toBeDefined();
    // The warning is about the secret, so it must not contain it.
    expect(warning).not.toContain("hunter2");
  });
});

describe("constant-time comparison", () => {
  it("matches only an exact secret", () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
    expect(secretsMatch(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(secretsMatch(`${SECRET}x`, SECRET)).toBe(false);
    expect(secretsMatch("", SECRET)).toBe(false);
  });

  it("survives a length mismatch instead of throwing", () => {
    // `timingSafeEqual` throws on differing byte lengths, which is why both
    // sides are hashed to a fixed 32 bytes first. A naive implementation
    // fails this test with a RangeError.
    expect(() => secretsMatch("x", SECRET)).not.toThrow();
    expect(secretsMatch("x".repeat(10_000), SECRET)).toBe(false);
  });

  it("handles non-ASCII candidates, where byte length differs from length", () => {
    expect(() => secretsMatch("🔐🔐🔐", SECRET)).not.toThrow();
    expect(secretsMatch("straße", "straße")).toBe(true);
    expect(secretsMatch("straße", "strasse")).toBe(false);
  });
});

describe("bearerCredential", () => {
  it("extracts only a well-formed Bearer credential", () => {
    expect(bearerCredential(`Bearer ${SECRET}`)).toBe(SECRET);
    expect(bearerCredential(`bearer ${SECRET}`)).toBe(SECRET);
    expect(bearerCredential(`  Bearer   ${SECRET}  `)).toBe(SECRET);
    expect(bearerCredential(undefined)).toBeUndefined();
    expect(bearerCredential(SECRET)).toBeUndefined();
    expect(bearerCredential(`Basic ${SECRET}`)).toBeUndefined();
    expect(bearerCredential("Bearer")).toBeUndefined();
    expect(bearerCredential("Bearer   ")).toBeUndefined();
    expect(bearerCredential("Bearertoken")).toBeUndefined();
  });

  it("has a defensive array branch that real HTTP cannot reach", () => {
    // Not an observable HTTP behaviour and deliberately not asserted as one:
    // Node discards repeated `Authorization` headers and keeps the first, so
    // `req.headers.authorization` is never an array and a request carrying
    // [correct, wrong] authenticates on the correct one and succeeds. The
    // branch is kept against a future transport that does surface arrays; the
    // test below pins the branch, not a property of this server.
    expect(
      bearerCredential([`Bearer ${SECRET}`, "Bearer other"])
    ).toBeUndefined();
  });

  it("authenticates on the first of two Authorization headers", async () => {
    // The actual, observable behaviour, written down so nobody re-derives the
    // stronger claim from the defensive branch above.
    const app = await serve(BEARER);
    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: {
        ...jsonHeaders,
        host: `127.0.0.1:${app.port}`,
        // An array writes two separate header lines on the wire.
        authorization: [`Bearer ${SECRET}`, "Bearer wrong"],
      },
      body: initializeBody(),
    });
    expect(response.status).toBe(200);
  });
});

/**
 * Issue #26: the health exemption let unauthenticated requests reach
 * `express.json()`, which is mounted after this middleware precisely so that
 * cannot happen. It had **two** doors, and the first fix only closed one:
 *
 * - keyed on the **path alone**, the exemption applied to every method, so a
 *   9 MiB `POST /healthz` was buffered and parsed uncredentialed;
 * - scoped to `GET`/`HEAD`, a `GET /healthz` with
 *   `Content-Type: application/json` still was, because `express.json()`
 *   parses by content type and not by method — and `GET` is the method the
 *   exemption has to allow. Measured at +381 MiB RSS for 24 concurrent 9 MiB
 *   requests, against a documented container limit of 256 MiB, and scaling
 *   linearly with the configured body limit.
 *
 * So the exemption now also requires that the request carry no body. Every
 * case below asserts the parser did not run, not merely that the status was
 * unhelpful.
 */
describe("the health exemption is scoped to GET/HEAD with no body", () => {
  /**
   * An app whose body parser is observable. If `express.json()` ever runs for
   * a request, `req.body` is set and this route reports how many bytes it
   * received — so "rejected before parsing" can be asserted directly rather
   * than inferred from a status code.
   */
  async function serveWithParserProbe(): Promise<{
    app: RunningApp;
    parsed: () => number;
  }> {
    let parsedRequests = 0;
    running = await startApp(
      createMcpHttpApp({
        auth: BEARER,
        createServer: testServer,
        security: SECURITY,
        health: {
          // A liveness-only app: no upstream is ever contacted.
          probeUpstream: async () => true,
        },
        // Rate limiting off: these tests send bursts and must reach the
        // middleware under test, not be shed before it.
        limits: {
          maxBody: "10mb",
          rateLimitMax: 0,
          rateLimitWindowMs: 60_000,
        },
      }).use((req, _res, next) => {
        // Mounted last, so it only sees requests that got past everything
        // else. `express.json()` sets `req.body` to `{}` at minimum.
        if (req.body !== undefined) parsedRequests += 1;
        next();
      })
    );
    return { app: running, parsed: () => parsedRequests };
  }

  /** ~200 kB of JSON: unmistakable if it is ever buffered. */
  const bigBody = JSON.stringify({ x: "A".repeat(200_000) });

  for (const path of UNAUTHENTICATED_PATHS) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      it(`rejects ${method} ${path} with 401 before the body is parsed`, async () => {
        const { app, parsed } = await serveWithParserProbe();
        const response = await rawRequest({
          port: app.port,
          path,
          method,
          headers: {
            ...jsonHeaders,
            host: `127.0.0.1:${app.port}`,
            "content-length": String(Buffer.byteLength(bigBody)),
          },
          body: bigBody,
        });

        expect(response.status).toBe(401);
        // The load-bearing half: not merely "not 200", but that nothing
        // downstream of the parser ever saw this request.
        expect(parsed()).toBe(0);
      });
    }

    for (const method of UNAUTHENTICATED_METHODS) {
      it(`still answers ${method} ${path} without a credential`, async () => {
        const { app } = await serveWithParserProbe();
        const response = await rawRequest({
          port: app.port,
          path,
          method,
          headers: { host: `127.0.0.1:${app.port}` },
        });
        expect(response.status).toBe(200);
      });

      // The second door. `GET` is the method the exemption *has* to allow,
      // and `express.json()` keys off `Content-Type`, not the method — so
      // this is the case that kept the hole open after the first fix.
      it(`rejects ${method} ${path} carrying a JSON body, unparsed`, async () => {
        const { app, parsed } = await serveWithParserProbe();
        const response = await rawRequest({
          port: app.port,
          path,
          method,
          headers: {
            ...jsonHeaders,
            host: `127.0.0.1:${app.port}`,
            "content-length": String(Buffer.byteLength(bigBody)),
          },
          body: bigBody,
        });

        expect(response.status).toBe(401);
        expect(parsed()).toBe(0);
      });

      it(`rejects ${method} ${path} with a chunked body, unparsed`, async () => {
        // No Content-Length to inspect: a chunked body is of unknown length,
        // which is the worst case rather than an excuse to allow it.
        const { app, parsed } = await serveWithParserProbe();
        const response = await rawRequest({
          port: app.port,
          path,
          method,
          headers: {
            ...jsonHeaders,
            host: `127.0.0.1:${app.port}`,
            "transfer-encoding": "chunked",
          },
          body: bigBody,
        });

        expect(response.status).toBe(401);
        expect(parsed()).toBe(0);
      });

      it(`still exempts ${method} ${path} with an explicit zero length`, async () => {
        // `Content-Length: 0` is a body-free request, and some probes send it.
        const { app } = await serveWithParserProbe();
        const response = await rawRequest({
          port: app.port,
          path,
          method,
          headers: { host: `127.0.0.1:${app.port}`, "content-length": "0" },
        });
        expect(response.status).toBe(200);
      });
    }
  }

  it("answers a probe path and an unknown path identically when unauthenticated", async () => {
    // The oracle #26 closed: `POST /healthz` used to be 404 while
    // `POST /nonexistent` was 401, which mapped the route table for free.
    const { app } = await serveWithParserProbe();
    const onProbe = await rawRequest({
      port: app.port,
      path: "/healthz",
      method: "POST",
      headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
      body: "{}",
    });
    const onUnknown = await rawRequest({
      port: app.port,
      path: "/nonexistent",
      method: "POST",
      headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
      body: "{}",
    });

    expect(onProbe.status).toBe(401);
    expect(onProbe.status).toBe(onUnknown.status);
    expect(onProbe.body).toBe(onUnknown.body);
    expect(onProbe.headers["www-authenticate"]).toBe(
      onUnknown.headers["www-authenticate"]
    );
  });

  it("answers a body-bearing GET identically on a probe path and elsewhere", async () => {
    // Why a body revokes the exemption rather than earning its own 400: a
    // distinct status here would re-open the route-existence oracle the test
    // above closes. The rule is uniform — on every path, an unauthenticated
    // request carrying a body is 401 and is never parsed.
    const { app, parsed } = await serveWithParserProbe();
    const send = (path: string) =>
      rawRequest({
        port: app.port,
        path,
        method: "GET",
        headers: {
          ...jsonHeaders,
          host: `127.0.0.1:${app.port}`,
          "content-length": String(Buffer.byteLength(bigBody)),
        },
        body: bigBody,
      });

    const onProbe = await send("/healthz");
    const onUnknown = await send("/nonexistent");

    expect(onProbe.status).toBe(401);
    expect(onProbe.status).toBe(onUnknown.status);
    expect(onProbe.body).toBe(onUnknown.body);
    expect(parsed()).toBe(0);
  });

  it("keeps the exemption available to an authenticated caller on any method", async () => {
    // Scoping the exemption must not make the paths unreachable — an
    // authenticated POST still gets the route's own answer (404: health
    // registers no POST handler), not a 401.
    const { app } = await serveWithParserProbe();
    const response = await rawRequest({
      port: app.port,
      path: "/healthz",
      method: "POST",
      headers: {
        ...jsonHeaders,
        host: `127.0.0.1:${app.port}`,
        authorization: `Bearer ${SECRET}`,
      },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });
});

describe("isPublicRequest", () => {
  /** Only the three things the predicate reads. */
  const req = (
    method: string,
    path: string,
    headers: Record<string, string> = {}
  ) => ({ method, path, headers }) as unknown as Parameters<
    typeof isPublicRequest
  >[0];

  it("requires the method and the path to match", () => {
    expect(isPublicRequest(req("GET", "/healthz"))).toBe(true);
    expect(isPublicRequest(req("HEAD", "/readyz"))).toBe(true);
    // One trailing slash is still normalized away.
    expect(isPublicRequest(req("GET", "/healthz/"))).toBe(true);

    // The first #26 door, in one line.
    expect(isPublicRequest(req("POST", "/healthz"))).toBe(false);
    expect(isPublicRequest(req("PUT", "/readyz"))).toBe(false);
    expect(isPublicRequest(req("DELETE", "/healthz"))).toBe(false);
    expect(isPublicRequest(req("OPTIONS", "/healthz"))).toBe(false);

    // A non-exempt path is never public, whatever the method.
    expect(isPublicRequest(req("GET", "/mcp"))).toBe(false);
    expect(isPublicRequest(req("GET", "/healthz/../mcp"))).toBe(false);
    expect(isPublicRequest(req("GET", "/healthzz"))).toBe(false);
    expect(isPublicRequest(req("GET", "//healthz"))).toBe(false);

    // HTTP methods are case-sensitive (RFC 9110 §9.1); a lowercase verb is
    // not the exempt one and is authenticated like anything else.
    expect(isPublicRequest(req("get", "/healthz"))).toBe(false);
  });

  it("refuses the exemption to anything carrying a body", () => {
    // The second #26 door: the method and path are both exempt, and it is
    // still not public, because `express.json()` would parse this.
    expect(
      isPublicRequest(req("GET", "/healthz", { "content-length": "1" }))
    ).toBe(false);
    expect(
      isPublicRequest(
        req("HEAD", "/readyz", { "transfer-encoding": "chunked" })
      )
    ).toBe(false);

    // A body-free request is still public, however it says so.
    expect(
      isPublicRequest(req("GET", "/healthz", { "content-length": "0" }))
    ).toBe(true);
    expect(
      isPublicRequest(
        req("GET", "/healthz", { "content-type": "application/json" })
      )
    ).toBe(true);
  });

  it("exempts read-only methods only", () => {
    expect([...UNAUTHENTICATED_METHODS].sort()).toEqual(["GET", "HEAD"]);
  });
});

describe("announcesBody", () => {
  const headers = (h: Record<string, string | string[]>) =>
    h as unknown as Parameters<typeof announcesBody>[0];

  it("reads the two headers that actually frame a body", () => {
    expect(announcesBody(headers({}))).toBe(false);
    expect(announcesBody(headers({ "content-length": "0" }))).toBe(false);
    expect(announcesBody(headers({ "content-length": " 0 " }))).toBe(false);
    expect(announcesBody(headers({ "content-length": "1" }))).toBe(true);
    expect(announcesBody(headers({ "content-length": "9437184" }))).toBe(true);
    expect(announcesBody(headers({ "transfer-encoding": "chunked" }))).toBe(
      true
    );
  });

  it("treats anything unreadable as a body", () => {
    // A malformed length is not a reason to relax: if it cannot be shown to
    // be zero, assume there are bytes behind it.
    expect(announcesBody(headers({ "content-length": "" }))).toBe(true);
    expect(announcesBody(headers({ "content-length": "abc" }))).toBe(true);
    expect(announcesBody(headers({ "content-length": "1.5" }))).toBe(true);
    expect(announcesBody(headers({ "content-length": "-1" }))).toBe(true);
    expect(announcesBody(headers({ "content-length": "0x10" }))).toBe(true);
    // Duplicated header: Node can surface an array. The first value decides.
    expect(announcesBody(headers({ "content-length": ["5", "0"] }))).toBe(true);
  });
});

describe("the bearer secret never reaches the logs", () => {
  it("stays out of stderr and stdout across accepted and rejected requests", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    // Resolved the way startup does it, so the secret goes through
    // `registerSecret` and the redactor knows about it.
    const auth = resolveHttpAuth({ [AUTH_TOKEN_ENV]: SECRET });
    const app = await serve(auth);

    const attempts = [
      { authorization: `Bearer ${SECRET}` },
      { authorization: `Bearer ${SECRET}-wrong` },
      { authorization: `Basic ${SECRET}` },
      {},
    ];
    for (const headers of attempts) {
      await rawRequest({
        port: app.port,
        path: "/mcp",
        headers: { ...jsonHeaders, ...headers, host: `127.0.0.1:${app.port}` },
        body: initializeBody(),
      });
    }

    const lines = stderr.mock.calls
      .map((call) => String(call[0]))
      .concat(stdout.mock.calls.map((call) => String(call[0])));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
      // No Authorization header, in any casing, ever appears in a record.
      expect(line.toLowerCase()).not.toContain("authorization");
      // Every stderr line is a structured record, never a raw dump.
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("is in the redaction registry, so a message that embeds it is scrubbed", async () => {
    // The previous test would pass even if `resolveHttpAuth` never called
    // `registerSecret`, because nothing on the happy path logs the secret.
    // This one cannot: it puts the secret inside a message that *is* logged
    // verbatim-but-redacted, which is exactly what the registry is for — the
    // realistic case being an error whose text embedded the header.
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    resolveHttpAuth({ [AUTH_TOKEN_ENV]: SECRET });

    // Bare, with no `Bearer ` in front of it: the generic auth-scheme pattern
    // in `redact()` would have caught that on its own, and the point here is
    // that the *registry* knows this particular value.
    logUnhandledRejection(
      new Error(`upstream rejected credential ${SECRET} for tenant 42`)
    );

    const record = JSON.parse(String(stderr.mock.calls.at(-1)?.[0]));
    expect(record.event).toBe("unhandled_rejection");
    expect(record.message).not.toContain(SECRET);
    expect(record.message).toContain("[redacted]");
  });
});

describe("the explicit unauthenticated mode", () => {
  it("serves without a credential, which is the point of the opt-out", async () => {
    const app = await serve(NO_AUTH);
    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
      body: initializeBody(),
    });
    expect(response.status).toBe(200);
  });
});
