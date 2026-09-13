import { describe, expect, it } from "vitest";
import {
  ACCEPT_HEADER,
  MAX_VERIFIED_PAPERLESS_VERSION,
  MIN_SUPPORTED_PAPERLESS_VERSION,
  PaperlessApiVersionError,
  REQUESTED_API_VERSION,
  buildApiVersionError,
  isApiVersionRejection,
  readServerApiVersion,
  readServerVersion,
  requestsApiVersion,
} from "../../src/api/apiVersion";

const headers = (values: Record<string, string>) => new Headers(values);

describe("isApiVersionRejection", () => {
  it("only treats 406 Not Acceptable as an API version rejection", () => {
    expect(isApiVersionRejection(406)).toBe(true);
    expect(isApiVersionRejection(400)).toBe(false);
    expect(isApiVersionRejection(401)).toBe(false);
    expect(isApiVersionRejection(404)).toBe(false);
    expect(isApiVersionRejection(500)).toBe(false);
  });
});

describe("requestsApiVersion", () => {
  it("recognizes the Accept header this client sends", () => {
    expect(requestsApiVersion({ headers: { Accept: ACCEPT_HEADER } })).toBe(
      true
    );
    expect(
      requestsApiVersion({ headers: { accept: "application/json;version=9" } })
    ).toBe(true);
    expect(
      requestsApiVersion({ headers: new Headers({ Accept: ACCEPT_HEADER }) })
    ).toBe(true);
    expect(requestsApiVersion({ headers: [["accept", ACCEPT_HEADER]] })).toBe(
      true
    );
  });

  it("is false for requests that negotiate no version", () => {
    // The upload and download paths send only an Authorization header.
    expect(requestsApiVersion({})).toBe(false);
    expect(
      requestsApiVersion({ headers: { Authorization: "Token x" } })
    ).toBe(false);
    expect(
      requestsApiVersion({ headers: { Accept: "application/json" } })
    ).toBe(false);
    expect(
      requestsApiVersion({ headers: { Accept: "application/json; version=8" } })
    ).toBe(false);
  });
});

describe("readServerApiVersion", () => {
  it("reads the X-Api-Version header Paperless-ngx adds to authenticated responses", () => {
    expect(readServerApiVersion(headers({ "X-Api-Version": "10" }))).toBe(10);
  });

  it("returns null when the header is missing", () => {
    expect(readServerApiVersion(headers({}))).toBeNull();
  });

  it("rejects values that are not a plausible version number", () => {
    expect(readServerApiVersion(headers({ "X-Api-Version": "abc" }))).toBeNull();
    expect(readServerApiVersion(headers({ "X-Api-Version": "0" }))).toBeNull();
    expect(readServerApiVersion(headers({ "X-Api-Version": "-3" }))).toBeNull();
    expect(
      readServerApiVersion(headers({ "X-Api-Version": "99999" }))
    ).toBeNull();
  });
});

describe("readServerVersion", () => {
  it("reads a plain version token", () => {
    expect(readServerVersion(headers({ "X-Version": "3.1.3" }))).toBe("3.1.3");
  });

  it("drops values that do not look like a version, so nothing arbitrary is echoed", () => {
    expect(
      readServerVersion(headers({ "X-Version": "3.1.3 <script>alert(1)" }))
    ).toBeNull();
    expect(readServerVersion(headers({ "X-Version": "x".repeat(64) }))).toBeNull();
    expect(readServerVersion(headers({}))).toBeNull();
  });
});

describe("buildApiVersionError", () => {
  it("tells the operator to upgrade the client when the instance has dropped v9", () => {
    const error = buildApiVersionError(
      headers({ "X-Api-Version": "12", "X-Version": "4.0.0" })
    );

    expect(error).toBeInstanceOf(PaperlessApiVersionError);
    expect(error.serverApiVersion).toBe(12);
    expect(error.serverVersion).toBe("4.0.0");
    expect(error.message).toContain(`API version ${REQUESTED_API_VERSION}`);
    expect(error.message).toContain("Paperless-ngx 4.0.0");
    expect(error.message).toContain("has dropped API version 9");
    expect(error.message).toContain("Upgrade @smic/paperless-mcp");
    expect(error.message).toContain(MAX_VERIFIED_PAPERLESS_VERSION);
  });

  it("tells the operator to upgrade Paperless-ngx when the instance is too old", () => {
    const error = buildApiVersionError(
      headers({ "X-Api-Version": "7", "X-Version": "2.14.0" })
    );

    expect(error.message).toContain("offers API version 7 at most");
    expect(error.message).toContain(
      `Upgrade Paperless-ngx to ${MIN_SUPPORTED_PAPERLESS_VERSION} or newer`
    );
  });

  it("stays actionable when the instance reports no version headers", () => {
    const error = buildApiVersionError(headers({}));

    expect(error.serverApiVersion).toBeNull();
    expect(error.serverVersion).toBeNull();
    expect(error.message).toContain("no X-Api-Version header");
    expect(error.message).toContain(MIN_SUPPORTED_PAPERLESS_VERSION);
    expect(error.message).toContain("API token is valid");
  });

  it("never interpolates a server version that is not a plain version token", () => {
    const error = buildApiVersionError(
      headers({
        "X-Api-Version": "10",
        "X-Version": "internal-host.example.invalid leaked secret",
      })
    );

    expect(error.message).not.toContain("leaked secret");
    expect(error.message).not.toContain("internal-host");
    expect(error.message).toContain("The instance has dropped API version 9");
  });

  it("states that the upstream body was not read", () => {
    expect(buildApiVersionError(headers({})).message).toContain(
      "response body was not read"
    );
  });
});
