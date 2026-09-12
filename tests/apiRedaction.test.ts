import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperlessAPI } from "../src/api/PaperlessAPI";
import { clearRegisteredSecrets, logFatal } from "../src/logging";

/**
 * Sentinels: if any of these ever shows up in captured output, the redaction
 * has regressed. They stand in for the Paperless token and for private
 * document data returned by the upstream API.
 *
 * `SENTINEL_TOKEN` deliberately matches none of the credential-shaped patterns
 * in `redact()` — no `Token ` prefix, no `?token=` query param — so the only
 * thing that can scrub it is the secret registry the `PaperlessAPI` constructor
 * populates. That makes the registration load-bearing in the tests below.
 */
const SENTINEL_TOKEN = "sentinel-token-9f8e7d6c5b4a";
const SENTINEL_TITLE = "SENTINEL-DOC-TITLE-Steuerbescheid-2024";
const SENTINEL_CONTENT = "SENTINEL-DOC-CONTENT-private-medical-note";
const SENTINEL_FILENAME = "SENTINEL-FILE-NAME-payslip.pdf";
const BASE_URL = "https://paperless.example";

const ALL_SENTINELS = [
  SENTINEL_TOKEN,
  SENTINEL_TITLE,
  SENTINEL_CONTENT,
  SENTINEL_FILENAME,
];

/** The exact set of fields a failed request may log. Nothing else. */
const SAFE_FAILURE_FIELDS = [
  "duration_ms",
  "endpoint",
  "error_class",
  "event",
  "level",
  "method",
  "status",
];

/** Upstream error payload, shaped like a real Paperless response. */
function upstreamErrorBody() {
  return JSON.stringify({
    detail: `Cannot process ${SENTINEL_TITLE}`,
    results: [
      {
        id: 4711,
        title: SENTINEL_TITLE,
        content: SENTINEL_CONTENT,
        permissions: { view: { users: ["alice"] } },
      },
    ],
  });
}

/** A TCP port nothing is listening on: bind, read the port, close again. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("PaperlessAPI failure logging", () => {
  let captured: string[];

  beforeEach(() => {
    captured = [];
    const capture = (...args: unknown[]) => {
      captured.push(
        args
          .map((arg) =>
            typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg)
          )
          .join(" ")
      );
    };
    for (const method of ["error", "warn", "log", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(capture);
    }
    for (const stream of [process.stderr, process.stdout]) {
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      }) as typeof stream.write);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearRegisteredSecrets();
  });

  /** Everything written to console/stderr/stdout during the test. */
  const output = () => captured.join("\n");

  function expectNoSentinels() {
    expect(captured.length).toBeGreaterThan(0);
    for (const sentinel of ALL_SENTINELS) {
      expect(output()).not.toContain(sentinel);
    }
  }

  describe("what is logged", () => {
    it("logs a failed request without the token, request body or response body", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(upstreamErrorBody(), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            })
        )
      );

      const api = new PaperlessAPI(BASE_URL, SENTINEL_TOKEN);
      await expect(
        api.updateDocument(4711, { title: SENTINEL_TITLE })
      ).rejects.toThrow("HTTP error! status: 500");

      expectNoSentinels();
      // The document id must not leak either — the endpoint is logged as a class.
      expect(output()).not.toContain("4711");

      const record = JSON.parse(captured[0]);
      expect(record).toMatchObject({
        level: "error",
        event: "paperless_request_failed",
        method: "PATCH",
        endpoint: "/documents/:id/",
        status: 500,
        error_class: "HttpStatusError",
      });
      expect(typeof record.duration_ms).toBe("number");
      // Nothing beyond the safe operational fields.
      expect(Object.keys(record).sort()).toEqual(SAFE_FAILURE_FIELDS);
    });

    it("does not leak uploaded file data when post_document fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(upstreamErrorBody(), { status: 413 }))
      );

      const api = new PaperlessAPI(BASE_URL, SENTINEL_TOKEN);
      const file = new File([SENTINEL_CONTENT], SENTINEL_FILENAME, {
        type: "application/pdf",
      });
      await expect(
        api.postDocument(file, { title: SENTINEL_TITLE })
      ).rejects.toThrow("HTTP error! status: 413");

      expectNoSentinels();
      const record = JSON.parse(captured[0]);
      expect(record).toMatchObject({
        method: "POST",
        endpoint: "/documents/post_document/",
        status: 413,
      });
      expect(Object.keys(record).sort()).toEqual(SAFE_FAILURE_FIELDS);
    });

    it("logs and raises a failed download instead of returning the error body", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(upstreamErrorBody(), { status: 404 }))
      );

      const api = new PaperlessAPI(BASE_URL, SENTINEL_TOKEN);
      await expect(api.downloadDocument(4711)).rejects.toThrow(
        "HTTP error! status: 404"
      );

      expectNoSentinels();
      const record = JSON.parse(captured[0]);
      expect(record).toMatchObject({
        method: "GET",
        endpoint: "/documents/:id/download/",
        status: 404,
      });
      expect(Object.keys(record).sort()).toEqual(SAFE_FAILURE_FIELDS);
    });

    it("stays silent on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ id: 4711, title: SENTINEL_TITLE }), {
              status: 200,
            })
        )
      );

      const api = new PaperlessAPI(BASE_URL, SENTINEL_TOKEN);
      await expect(api.getDocument(4711)).resolves.toMatchObject({ id: 4711 });
      expect(captured).toEqual([]);
    });
  });

  describe("endpoint normalization is what keeps private values out of the endpoint field", () => {
    it("reduces a search query to the endpoint class", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(upstreamErrorBody(), { status: 400 }))
      );

      const api = new PaperlessAPI(BASE_URL, SENTINEL_TOKEN);
      await expect(api.searchDocuments(SENTINEL_CONTENT)).rejects.toThrow();

      expectNoSentinels();
      // Exact equality: if the query string survived, this is `/documents/:id`.
      expect(JSON.parse(captured[0]).endpoint).toBe("/documents/");
    });

    it("reduces a secret-bearing path segment to the endpoint class", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(upstreamErrorBody(), { status: 404 }))
      );

      const api = new PaperlessAPI(BASE_URL, SENTINEL_TOKEN);
      // A caller passing something private where an id belongs.
      await expect(api.getTag(SENTINEL_TITLE)).rejects.toThrow();

      expectNoSentinels();
      expect(JSON.parse(captured[0]).endpoint).toBe("/tags/:id/");
    });
  });

  describe("secret registration is what keeps the token out of unrelated log lines", () => {
    it("scrubs the token from an error message raised elsewhere in the process", () => {
      // Constructing the client is the only thing that registers the token.
      new PaperlessAPI(BASE_URL, SENTINEL_TOKEN);

      // A bare token in free text: no auth scheme, no query param, so the
      // secret registry is the only thing standing between it and the log.
      logFatal(new Error(`giving up after retrying with ${SENTINEL_TOKEN}`));

      expect(captured).toHaveLength(1);
      expect(output()).not.toContain(SENTINEL_TOKEN);
      expect(JSON.parse(captured[0]).message).toBe(
        "giving up after retrying with [redacted]"
      );
    });

    it("scrubs a token that reaches a request log field", () => {
      new PaperlessAPI(BASE_URL, SENTINEL_TOKEN);
      // `log()` redacts every string field, whichever one carries the value.
      logFatal(new Error(SENTINEL_TOKEN));
      expect(JSON.parse(captured[0]).message).toBe("[redacted]");
    });
  });

  describe("real transport failures", () => {
    it("classifies a refused connection usefully and logs nothing else", async () => {
      const port = await closedPort();
      const api = new PaperlessAPI(`http://127.0.0.1:${port}`, SENTINEL_TOKEN);

      await expect(api.getDocuments()).rejects.toThrow(
        "Paperless request failed: GET /documents/"
      );

      const record = JSON.parse(captured[0]);
      expect(record).toMatchObject({
        level: "error",
        event: "paperless_request_failed",
        method: "GET",
        endpoint: "/documents/",
        error_class: "TypeError:ECONNREFUSED",
      });
      // No status: the request never reached the server.
      expect(Object.keys(record).sort()).toEqual(
        SAFE_FAILURE_FIELDS.filter((field) => field !== "status")
      );
      expect(output()).not.toContain(SENTINEL_TOKEN);
    });

    it("classifies a refused connection to a dual-stack host usefully", async () => {
      // `localhost` resolves to both ::1 and 127.0.0.1, so Node's happy-eyeballs
      // wraps the failures in an AggregateError.
      const port = await closedPort();
      const api = new PaperlessAPI(`http://localhost:${port}`, SENTINEL_TOKEN);

      await expect(api.getDocuments()).rejects.toThrow();
      expect(JSON.parse(captured[0]).error_class).toBe(
        "TypeError:ECONNREFUSED"
      );
    });

    it("classifies a connection reset (server hangs up mid-handshake)", async () => {
      const server = net.createServer((socket) => socket.destroy());
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve())
      );
      const port = (server.address() as net.AddressInfo).port;
      try {
        // https against a plain socket that drops the connection.
        const api = new PaperlessAPI(
          `https://127.0.0.1:${port}`,
          SENTINEL_TOKEN
        );
        await expect(api.getDocuments()).rejects.toThrow();
        expect(JSON.parse(captured[0]).error_class).toMatch(
          /^TypeError:[A-Z][A-Z0-9_]*$/
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
