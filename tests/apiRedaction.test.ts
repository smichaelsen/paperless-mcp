import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperlessAPI } from "../src/api/PaperlessAPI";
import { clearRegisteredSecrets } from "../src/logging";

/**
 * Sentinels: if any of these ever shows up in captured output, the redaction
 * has regressed. They stand in for the Paperless token and for private
 * document data returned by the upstream API.
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
    for (const sentinel of ALL_SENTINELS) {
      expect(output()).not.toContain(sentinel);
    }
  }

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
    expect(Object.keys(record).sort()).toEqual([
      "duration_ms",
      "endpoint",
      "error_class",
      "event",
      "level",
      "method",
      "status",
    ]);
  });

  it("does not leak the search query of a failed search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(upstreamErrorBody(), { status: 400 }))
    );

    const api = new PaperlessAPI(BASE_URL, SENTINEL_TOKEN);
    await expect(api.searchDocuments(SENTINEL_CONTENT)).rejects.toThrow();

    expectNoSentinels();
    expect(JSON.parse(captured[0]).endpoint).toBe("/documents/");
  });

  it("does not leak a token embedded in a transport error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // Mirrors undici, whose errors quote the request URL.
        throw Object.assign(
          new TypeError(
            `fetch failed: ${BASE_URL}/api/documents/?token=${SENTINEL_TOKEN}`
          ),
          { cause: { code: "ECONNREFUSED" } }
        );
      })
    );

    const api = new PaperlessAPI(BASE_URL, SENTINEL_TOKEN);
    await expect(api.getDocuments()).rejects.toThrow(
      "Paperless request failed: GET /documents/"
    );

    expectNoSentinels();
    expect(JSON.parse(captured[0])).toMatchObject({
      event: "paperless_request_failed",
      method: "GET",
      endpoint: "/documents/",
      error_class: "TypeError:ECONNREFUSED",
    });
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
    expect(JSON.parse(captured[0])).toMatchObject({
      method: "POST",
      endpoint: "/documents/post_document/",
      status: 413,
    });
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
    expect(JSON.parse(captured[0])).toMatchObject({
      method: "GET",
      endpoint: "/documents/:id/download/",
      status: 404,
    });
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
