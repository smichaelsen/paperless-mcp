import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRegisteredSecrets,
  errorClass,
  log,
  logFatal,
  logRequestFailure,
  normalizeEndpoint,
  redact,
  registerSecret,
} from "../src/logging";

describe("normalizeEndpoint", () => {
  it("keeps plain resource paths", () => {
    expect(normalizeEndpoint("/documents/")).toBe("/documents/");
    expect(normalizeEndpoint("/documents/bulk_edit/")).toBe(
      "/documents/bulk_edit/"
    );
  });

  it("replaces numeric ids with a class marker", () => {
    expect(normalizeEndpoint("/documents/4711/")).toBe("/documents/:id/");
    expect(normalizeEndpoint("/documents/4711/download/")).toBe(
      "/documents/:id/download/"
    );
  });

  it("drops the query string", () => {
    expect(normalizeEndpoint("/documents/?query=tax%20return&page=2")).toBe(
      "/documents/"
    );
    expect(normalizeEndpoint("/documents/?page=2")).toBe("/documents/");
  });

  it("masks anything that is not a lowercase snake_case segment", () => {
    expect(normalizeEndpoint("/documents/9f8e-uuid-1234/")).toBe(
      "/documents/:id/"
    );
    expect(normalizeEndpoint("/documents/Invoice%20Acme/")).toBe(
      "/documents/:id/"
    );
    // Mixed case and hyphens are exactly what a document title looks like.
    expect(normalizeEndpoint("/tags/SENTINEL-DOC-TITLE-Bescheid-2024/")).toBe(
      "/tags/:id/"
    );
    expect(normalizeEndpoint("/documents/tax-return/")).toBe("/documents/:id/");
  });

  it("handles the root path", () => {
    expect(normalizeEndpoint("/")).toBe("/");
    expect(normalizeEndpoint("")).toBe("/");
  });
});

describe("redact", () => {
  afterEach(() => clearRegisteredSecrets());

  it("removes registered secrets", () => {
    registerSecret("sentinel-token-abc123");
    expect(redact("connect failed for sentinel-token-abc123")).not.toContain(
      "sentinel-token-abc123"
    );
    expect(redact("sentinel-token-abc123")).toContain("[redacted]");
  });

  it("ignores implausibly short secrets", () => {
    registerSecret("ab");
    expect(redact("a stable build")).toBe("a stable build");
  });

  it("removes authorization scheme values", () => {
    expect(redact("Authorization: Token deadbeefcafe")).not.toContain(
      "deadbeefcafe"
    );
    expect(redact("Bearer deadbeefcafe")).not.toContain("deadbeefcafe");
  });

  it("removes credentials embedded in URLs", () => {
    const redacted = redact(
      "request to https://admin:hunter2@paperless.example/api/ failed"
    );
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("paperless.example");
  });

  it("removes credential-shaped query parameters", () => {
    const redacted = redact(
      "https://paperless.example/api/?api_key=s3cr3tvalue&page=2"
    );
    expect(redacted).not.toContain("s3cr3tvalue");
    expect(redacted).toContain("page=2");
  });
});

describe("errorClass", () => {
  it("reports the error name without the message", () => {
    expect(errorClass(new TypeError("token abc is bad"))).toBe("TypeError");
  });

  it("appends the errno code of a fetch cause", () => {
    // The shape Node produces for a single-address connection failure.
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:80"), {
      code: "ECONNREFUSED",
    });
    const error = new TypeError("fetch failed", { cause });
    expect(errorClass(error)).toBe("TypeError:ECONNREFUSED");
  });

  it("digs the errno code out of a happy-eyeballs AggregateError", () => {
    // Multi-address failures nest the real codes in `errors[]`; some Node
    // versions leave the AggregateError itself without a `code`.
    const cause = new AggregateError(
      [
        Object.assign(new Error("connect ECONNREFUSED ::1:80"), {
          code: "ECONNREFUSED",
        }),
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:80"), {
          code: "ECONNREFUSED",
        }),
      ],
      "all connection attempts failed"
    );
    const error = new TypeError("fetch failed", { cause });
    expect(errorClass(error)).toBe("TypeError:ECONNREFUSED");
  });

  it("never degrades to a useless bare-Error cause class", () => {
    const error = new TypeError("fetch failed", { cause: new Error("nope") });
    expect(errorClass(error)).toBe("TypeError");
  });

  it("ignores a non-errno code so free text cannot reach the log", () => {
    const cause = Object.assign(new Error("x"), {
      code: "failed while fetching SENTINEL-DOC-TITLE",
    });
    expect(errorClass(new TypeError("fetch failed", { cause }))).toBe(
      "TypeError"
    );
  });

  it("handles non-errors", () => {
    expect(errorClass("boom")).toBe("string");
  });
});

describe("log output", () => {
  let stderr: string[];

  beforeEach(() => {
    stderr = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearRegisteredSecrets();
  });

  it("emits a single JSON line per record", () => {
    log("info", "started", { transport: "stdio" });
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).not.toContain("\n");
    expect(JSON.parse(stderr[0])).toEqual({
      level: "info",
      event: "started",
      transport: "stdio",
    });
  });

  it("logs only safe operational fields for a failed request", () => {
    logRequestFailure({
      method: "GET",
      endpoint: "/documents/:id/",
      status: 500,
      durationMs: 12,
      errorClass: "HttpStatusError",
    });
    expect(JSON.parse(stderr[0])).toEqual({
      level: "error",
      event: "paperless_request_failed",
      method: "GET",
      endpoint: "/documents/:id/",
      status: 500,
      duration_ms: 12,
      error_class: "HttpStatusError",
    });
  });

  it("redacts string field values", () => {
    registerSecret("sentinel-token-abc123");
    log("error", "boom", { detail: "used sentinel-token-abc123" });
    expect(stderr[0]).not.toContain("sentinel-token-abc123");
  });

  it("does not leak a credential carried by a fatal error", () => {
    registerSecret("sentinel-token-abc123");
    logFatal(
      new Error(
        "request to https://paperless.example/api/?token=sentinel-token-abc123 failed"
      )
    );
    const line = stderr.join("\n");
    expect(line).not.toContain("sentinel-token-abc123");
    expect(JSON.parse(stderr[0]).error_class).toBe("Error");
  });

  it("does not leak a credential embedded in a URL userinfo section", () => {
    logFatal(new Error("connect https://user:sup3rs3cret@paperless.example/"));
    expect(stderr.join("\n")).not.toContain("sup3rs3cret");
  });

  it("never logs a stack trace", () => {
    logFatal(new Error("nope"));
    expect(stderr.join("\n")).not.toContain("logging.test.ts");
  });
});
