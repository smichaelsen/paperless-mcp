/**
 * `/healthz` and `/readyz` (issue #10).
 *
 * These are the only two routes on this server that answer *without*
 * credentials, so the tests hold them to four separate promises:
 *
 * 1. they distinguish process liveness from Paperless reachability;
 * 2. they say nothing else — no version, no URL, no configuration, no upstream
 *    error;
 * 3. being unauthenticated does not put them outside the rest of the boundary:
 *    a forged Host is still refused, the rate limiter still counts them, and
 *    `/readyz` cannot be used to drive traffic at Paperless;
 * 4. the exemption is exactly two paths and exactly their spelling — no method,
 *    no case variant and no neighbouring path inherits it.
 *
 * Every app built here has **bearer authentication enabled**, because that is
 * the shape the server actually runs in after #11: the point is not that these
 * routes answer on an open server, it is that they answer on a closed one.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpAuthConfig } from "../../src/config/httpAuth";
import { UNAUTHENTICATED_PATHS } from "../../src/config/httpAuth";
import { createMcpHttpApp, McpHttpAppOptions } from "../../src/http/app";
import {
  createReadinessGate,
  DEFAULT_NOT_READY_TTL_MS,
  DEFAULT_READY_TTL_MS,
  HEALTH_PATH,
  READY_PATH,
  UpstreamProbe,
} from "../../src/http/health";
import { DEFAULT_MAX_BODY } from "../../src/http/limits";
import { DEFAULT_ALLOWED_HOSTS } from "../../src/http/security";
import { initializeBody, rawRequest, RunningApp, startApp } from "./harness";

const SECURITY = {
  allowedHosts: DEFAULT_ALLOWED_HOSTS,
  allowedOrigins: [] as string[],
};

/**
 * Distinctive strings that a leaking handler would have to pull from
 * somewhere. Each one is genuinely present in the app under test: the URL is
 * closed over by the probe, the name and version are on the `McpServer`, the
 * secret is in the auth config.
 */
const PAPERLESS_URL = "https://paperless.internal.invalid";
const SERVER_NAME = "paperless-ngx";
const SERVER_VERSION = "9.8.7-canary";
const SECRET = "health-test-bearer-secret-0123456789";

const AUTH: HttpAuthConfig = {
  mode: "bearer",
  secret: SECRET,
  source: "PAPERLESS_MCP_AUTH_TOKEN",
};

let running: RunningApp | undefined;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (running) await running.close();
  running = undefined;
  vi.restoreAllMocks();
});

function buildApp(
  health: McpHttpAppOptions["health"],
  overrides: Partial<McpHttpAppOptions> = {}
) {
  return createMcpHttpApp({
    createServer: () =>
      new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }),
    auth: AUTH,
    security: SECURITY,
    health,
    ...overrides,
  });
}

/** A probe that always succeeds, and counts how often it ran. */
function countingProbe(result: "resolve" | "reject" = "resolve") {
  const calls: AbortSignal[] = [];
  const probe: UpstreamProbe = async (signal) => {
    calls.push(signal);
    if (result === "reject") {
      // The shape `PaperlessAPI` actually throws, including a URL that must
      // not reach the response.
      throw new Error(`Paperless request failed: GET ${PAPERLESS_URL}/api/`);
    }
    return { ok: true };
  };
  return { probe, calls };
}

async function request(
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {}
) {
  return rawRequest({
    port: running!.port,
    path,
    method: options.method ?? "GET",
    headers: options.headers ?? {},
  });
}

const get = (path: string, headers: Record<string, string> = {}) =>
  request(path, { headers });

describe("liveness and readiness are different questions", () => {
  it("reports liveness without ever consulting Paperless", async () => {
    const { probe, calls } = countingProbe();
    running = await startApp(buildApp({ probeUpstream: probe }));

    const response = await get(HEALTH_PATH);

    expect(response.status).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
    // The whole point of splitting the two: a Paperless outage must not make
    // the container look dead and get it restarted.
    expect(calls).toHaveLength(0);
  });

  it("stays live while Paperless is unreachable, but reports not ready", async () => {
    const { probe, calls } = countingProbe("reject");
    running = await startApp(buildApp({ probeUpstream: probe }));

    const live = await get(HEALTH_PATH);
    const ready = await get(READY_PATH);

    expect(live.status).toBe(200);
    expect(ready.status).toBe(503);
    expect(ready.body).toBe('{"status":"unavailable"}');
    expect(calls).toHaveLength(1);
  });

  it("reports ready when Paperless answers", async () => {
    const { probe } = countingProbe();
    running = await startApp(buildApp({ probeUpstream: probe }));

    const response = await get(READY_PATH);

    expect(response.status).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
  });

  it("fails readiness closed when no upstream probe is wired up", async () => {
    // If the wiring in `src/index.ts` is ever lost, the endpoint must not
    // start answering "ready" to a question it is no longer asking.
    running = await startApp(buildApp(undefined));

    expect((await get(READY_PATH)).status).toBe(503);
    expect((await get(HEALTH_PATH)).status).toBe(200);
  });
});

describe("the probes answer on an authenticated server", () => {
  it("serves both probes with no credential while /mcp refuses one", async () => {
    const { probe } = countingProbe();
    running = await startApp(buildApp({ probeUpstream: probe }));

    // Same app, same middleware chain, no Authorization header anywhere.
    const mcp = await rawRequest({
      port: running.port,
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });

    expect(mcp.status).toBe(401);
    expect((await get(HEALTH_PATH)).status).toBe(200);
    expect((await get(READY_PATH)).status).toBe(200);
  });

  it("exempts exactly the two probe paths and nothing else", async () => {
    // A future edit to this list must be a deliberate one: adding a path here
    // takes it outside authentication entirely.
    expect([...UNAUTHENTICATED_PATHS].sort()).toEqual(
      [HEALTH_PATH, READY_PATH].sort()
    );
  });

  it("does not serve case variants of the probe paths", async () => {
    const { probe, calls } = countingProbe();
    running = await startApp(buildApp({ probeUpstream: probe }));

    // Express routes case-insensitively; `bearerAuth`'s exemption list does
    // not. `/HEALTHZ` is therefore answered 401 by authentication before it
    // reaches a handler, and the handler would refuse it anyway. Both layers
    // agree, and the assertion is on the property — never served — rather than
    // on which layer says no, so it survives a change of mind about the other.
    for (const path of ["/HEALTHZ", "/ReadyZ"]) {
      const response = await get(path);
      expect(response.status).not.toBe(200);
      expect(response.body).not.toContain('"status":"ok"');
    }
    expect(calls).toHaveLength(0);
  });

  it("serves the documented spelling, with or without a trailing slash", async () => {
    const { probe } = countingProbe();
    running = await startApp(buildApp({ probeUpstream: probe }));

    // `isPublicPath` normalizes one trailing slash, so the handler does too —
    // otherwise a probe URL with a slash would pass authentication and then
    // 404, which is a confusing way to say "healthy".
    expect((await get(HEALTH_PATH)).status).toBe(200);
    expect((await get(`${HEALTH_PATH}/`)).status).toBe(200);
    expect((await get(READY_PATH)).status).toBe(200);
  });
});

describe("the probes expose nothing but a verdict", () => {
  it.each([
    ["reachable", "resolve" as const, 200],
    ["unreachable", "reject" as const, 503],
  ])(
    "leaks no version, URL or configuration while Paperless is %s",
    async (_label, mode, expectedStatus) => {
      const { probe } = countingProbe(mode);
      running = await startApp(buildApp({ probeUpstream: probe }));

      for (const path of [HEALTH_PATH, READY_PATH]) {
        const response = await get(path);
        const wire = `${JSON.stringify(response.headers)}\n${response.body}`;

        if (path === READY_PATH) expect(response.status).toBe(expectedStatus);

        // Every one of these is reachable from inside the handler's process,
        // so none of them can be absent by accident.
        expect(wire).not.toContain(PAPERLESS_URL);
        expect(wire).not.toContain("paperless");
        expect(wire).not.toContain(SERVER_VERSION);
        expect(wire).not.toContain("PAPERLESS_");
        expect(wire).not.toContain("invalid");
        expect(wire).not.toContain("Paperless request failed");
        expect(wire).not.toContain(SECRET);
        // Configuration the rest of the app knows and these routes must not
        // volunteer to an unauthenticated caller.
        expect(wire).not.toContain(DEFAULT_MAX_BODY);
        expect(response.headers["x-powered-by"]).toBeUndefined();
      }
    }
  );

  it("returns one fixed body per verdict and nothing more", async () => {
    const { probe } = countingProbe();
    running = await startApp(buildApp({ probeUpstream: probe }));

    const response = await get(READY_PATH);

    // Exact equality, not a subset match: a field added later — an upstream
    // status, a duration, a "checks" object — is a regression here, and a
    // subset assertion would not see it.
    expect(JSON.parse(response.body)).toEqual({ status: "ok" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("sets no ETag, so a revalidating prober never gets a 304", async () => {
    const { probe } = countingProbe();
    running = await startApp(buildApp({ probeUpstream: probe }));

    const first = await get(HEALTH_PATH);
    expect(first.headers["etag"]).toBeUndefined();

    // The failure this prevents: `res.json()` attaches a weak ETag even under
    // `no-store`, and a proxy that revalidates then gets `304` — which is not
    // `response.ok`, so a healthy service reads as unhealthy.
    const revalidated = await get(HEALTH_PATH, {
      "if-none-match": 'W/"f-PGrUhX+tdJK9m/vk9MmA+4RiUrE"',
    });
    expect(revalidated.status).toBe(200);
    expect(revalidated.body).toBe('{"status":"ok"}');
  });

  it("answers HEAD with the status and no body", async () => {
    const { probe } = countingProbe();
    running = await startApp(buildApp({ probeUpstream: probe }));

    const response = await request(HEALTH_PATH, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.body).toBe("");
  });

  it.each(["POST", "PUT", "DELETE"])(
    "gives %s on a probe path no verdict and no extra signal",
    async (method) => {
      const { probe, calls } = countingProbe();
      running = await startApp(buildApp({ probeUpstream: probe }));

      const onProbePath = await request(READY_PATH, { method });
      const onUnknownPath = await request("/nonexistent", { method });

      // No write verb produces a verdict, and none of them reaches Paperless.
      expect(onProbePath.status).toBe(401);
      expect(onProbePath.body).not.toContain('"status"');
      expect(calls).toHaveLength(0);

      // Issue #26 changed this from 404 to 401, and made the two identical.
      // The exemption is keyed on the path *and* the method, so a write verb
      // on a probe path is authenticated like any other request — which is
      // what stops it from reaching `express.json()` and having a 9 MiB body
      // buffered for it. Answering both alike also stops an unauthenticated
      // prober from mapping which routes exist.
      expect(onUnknownPath.status).toBe(401);
      expect(onProbePath.status).toBe(onUnknownPath.status);
      expect(onProbePath.body).toBe(onUnknownPath.body);
    }
  );
});

describe("the probes stay inside the rest of the HTTP boundary", () => {
  // Being exempt from authentication is not the same as being exempt from
  // everything: the routes are registered *after* the app-wide middleware, so
  // Host/Origin validation and the rate limiter both cover them. Asserted by
  // behaviour, not by reading the middleware list.
  it.each([HEALTH_PATH, READY_PATH])(
    "rejects a forged Host on %s",
    async (path) => {
      const { probe, calls } = countingProbe();
      running = await startApp(buildApp({ probeUpstream: probe }));

      const response = await get(path, { Host: "evil.example" });

      expect(response.status).toBe(403);
      // The rejection happened before the handler ran, so an unauthenticated
      // caller on a forged Host cannot even trigger the upstream probe.
      expect(calls).toHaveLength(0);
    }
  );

  it.each([HEALTH_PATH, READY_PATH])(
    "rejects a browser Origin on %s",
    async (path) => {
      const { probe } = countingProbe();
      running = await startApp(buildApp({ probeUpstream: probe }));

      const response = await get(path, { Origin: "https://evil.example" });

      expect(response.status).toBe(403);
    }
  );

  it.each([HEALTH_PATH, READY_PATH])(
    "counts %s against the rate limit like any other route",
    async (path) => {
      const { probe } = countingProbe();
      running = await startApp(
        buildApp(
          { probeUpstream: probe },
          {
            limits: {
              maxBody: DEFAULT_MAX_BODY,
              rateLimitMax: 2,
              rateLimitWindowMs: 60_000,
            },
          }
        )
      );

      const first = await get(path);
      const second = await get(path);
      const third = await get(path);

      expect([first.status, second.status]).not.toContain(429);
      // Unauthenticated *and* unmetered would make these the cheapest way to
      // flood the process. The limiter runs before the routes, so they are
      // metered exactly like `/mcp`.
      expect(third.status).toBe(429);
      expect(third.headers["retry-after"]).toBeDefined();
    }
  );

  it("shares one rate-limit budget with the authenticated routes", async () => {
    const { probe } = countingProbe();
    running = await startApp(
      buildApp(
        { probeUpstream: probe },
        {
          limits: {
            maxBody: DEFAULT_MAX_BODY,
            rateLimitMax: 2,
            rateLimitWindowMs: 60_000,
          },
        }
      )
    );

    // Two probe requests exhaust the window, so the *next* request to /mcp is
    // refused by the limiter — proof the probes are inside the same bucket
    // rather than on a bypass of their own.
    await get(HEALTH_PATH);
    await get(READY_PATH);
    const mcp = await rawRequest({
      port: running.port,
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${SECRET}`,
      },
      body: initializeBody(),
    });

    expect(mcp.status).toBe(429);
  });
});

describe("readiness cannot be used to hammer Paperless", () => {
  it("serves a burst of requests from a single upstream probe", async () => {
    const { probe, calls } = countingProbe();
    running = await startApp(buildApp({ probeUpstream: probe }));

    const responses = await Promise.all(
      Array.from({ length: 25 }, () => get(READY_PATH))
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    // 25 unauthenticated requests, one request to Paperless. Without the cache
    // and the single-flight guard this endpoint would be an amplifier.
    expect(calls).toHaveLength(1);
  });

  it("coalesces concurrent probes into one in-flight call", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const isReady = createReadinessGate({
      probeUpstream: async () => {
        started += 1;
        await gate;
      },
    });

    const pending = [isReady(), isReady(), isReady()];
    release();
    const verdicts = await Promise.all(pending);

    expect(verdicts).toEqual([true, true, true]);
    expect(started).toBe(1);
  });

  it("reuses a successful verdict for the success TTL, then re-probes", async () => {
    let now = 1_000;
    const { probe, calls } = countingProbe();
    const isReady = createReadinessGate({
      probeUpstream: probe,
      now: () => now,
    });

    expect(await isReady()).toBe(true);
    now += DEFAULT_READY_TTL_MS - 1;
    expect(await isReady()).toBe(true);
    expect(calls).toHaveLength(1);

    now += 2;
    expect(await isReady()).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("retries a failed verdict sooner than a successful one", async () => {
    let now = 1_000;
    let fail = true;
    const calls: number[] = [];
    const isReady = createReadinessGate({
      probeUpstream: async () => {
        calls.push(now);
        if (fail) throw new Error("upstream down");
        return "ok";
      },
      now: () => now,
    });

    expect(await isReady()).toBe(false);

    // Still inside the failure TTL: cached, no second call.
    now += DEFAULT_NOT_READY_TTL_MS - 1;
    expect(await isReady()).toBe(false);
    expect(calls).toHaveLength(1);

    // Past the failure TTL but well inside the success TTL: a recovering
    // Paperless is noticed here, which is the whole reason the two differ.
    now += 2;
    fail = false;
    expect(await isReady()).toBe(true);
    expect(calls).toHaveLength(2);
    expect(DEFAULT_NOT_READY_TTL_MS).toBeLessThan(DEFAULT_READY_TTL_MS);
  });

  it(
    "gives up on a hung upstream instead of hanging with it",
    async () => {
      let aborted = false;
      const isReady = createReadinessGate({
        probeTimeoutMs: 20,
        probeUpstream: (signal) =>
          new Promise((_resolve, reject) => {
            // A probe that only ever settles on abort: if the deadline is
            // removed this never resolves and the test times out.
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
      });

      expect(await isReady()).toBe(false);
      expect(aborted).toBe(true);
    },
    2_000
  );
});
