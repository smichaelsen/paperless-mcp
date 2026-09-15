import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_URL_ENV,
  BrowserUrlError,
  documentDownloadUrl,
  resolvePaperlessBrowserUrl,
} from "../src/config/browserUrl";
import { clearRegisteredSecrets, log } from "../src/logging";

describe("Paperless browser URL configuration", () => {
  let captured: string[];

  beforeEach(() => {
    captured = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      captured.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearRegisteredSecrets();
  });

  it("is absent when PAPERLESS_BROWSER_URL is missing or blank", () => {
    expect(resolvePaperlessBrowserUrl({})).toBeUndefined();
    expect(
      resolvePaperlessBrowserUrl({ [BROWSER_URL_ENV]: "   " })
    ).toBeUndefined();
  });

  it.each([
    "https://paperless.example",
    "http://localhost:8000",
    "https://paperless.example/paperless/",
  ])("accepts an absolute HTTP(S) URL: %s", (configured) => {
    expect(resolvePaperlessBrowserUrl({ [BROWSER_URL_ENV]: configured }))
      .toBeInstanceOf(URL);
  });

  it.each([
    ["relative URL", "/paperless"],
    ["unsupported scheme", "ftp://paperless.example/files"],
    ["username", "https://admin@paperless.example"],
    ["password", "https://admin:secret@paperless.example"],
    ["query string", "https://paperless.example/?token=secret"],
    ["fragment", "https://paperless.example/#secret"],
  ])("rejects a %s without echoing its value", (_label, configured) => {
    let error: unknown;
    try {
      resolvePaperlessBrowserUrl({ [BROWSER_URL_ENV]: configured });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BrowserUrlError);
    expect(String(error)).toContain(BROWSER_URL_ENV);
    expect(String(error)).not.toContain(configured);
  });

  it("redacts the deployment URL if another component tries to log it", () => {
    const configured = "https://browser-only.example/paperless";
    resolvePaperlessBrowserUrl({ [BROWSER_URL_ENV]: configured });

    log("error", "synthetic_failure", {
      url: `${configured}/api/documents/42/download/`,
    });

    expect(captured.join("\n")).not.toContain(configured);
    expect(captured.join("\n")).toContain("[redacted]");
  });
});

describe("documentDownloadUrl", () => {
  it("builds the archived download endpoint", () => {
    expect(
      documentDownloadUrl(new URL("https://paperless.example"), 42)
    ).toBe("https://paperless.example/api/documents/42/download/");
  });

  it("preserves a sub-path deployment and normalizes its trailing slash", () => {
    for (const configured of [
      "https://paperless.example/paperless",
      "https://paperless.example/paperless/",
    ]) {
      expect(documentDownloadUrl(new URL(configured), 42)).toBe(
        "https://paperless.example/paperless/api/documents/42/download/"
      );
    }
  });

  it("uses Paperless's documented original=true query", () => {
    expect(
      documentDownloadUrl(new URL("https://paperless.example"), 42, true)
    ).toBe(
      "https://paperless.example/api/documents/42/download/?original=true"
    );
  });
});
