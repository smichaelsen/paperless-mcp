import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperlessAPI } from "../../src/api/PaperlessAPI";
import {
  PaperlessApiVersionError,
  REQUESTED_API_VERSION,
} from "../../src/api/apiVersion";
import {
  emptyResponse,
  jsonResponse,
  mockFetch,
  textResponse,
} from "../helpers/fetchMock";

const BASE_URL = "https://paperless.example.invalid";
const TOKEN = "s3cr3t-token-value";

const api = () => new PaperlessAPI(BASE_URL, TOKEN);

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Everything console.error saw during a test, as one searchable string. */
const loggedText = () =>
  consoleError.mock.calls
    .map((args) => args.map((arg) => JSON.stringify(arg)).join(" "))
    .join("\n");

describe("PaperlessAPI.request — happy path", () => {
  it("prefixes the path with <baseUrl>/api and returns parsed JSON", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ count: 2, results: [] }));

    const result = await api().request("/documents/?page=2");

    expect(fetchMock.only().url).toBe(
      `${BASE_URL}/api/documents/?page=2`
    );
    expect(result).toEqual({ count: 2, results: [] });
  });

  it("sends the token and the negotiated Accept version header", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));

    await api().request("/tags/");

    const call = fetchMock.only();
    expect(fetchMock.headerOf(call, "authorization")).toBe(`Token ${TOKEN}`);
    expect(fetchMock.headerOf(call, "accept")).toBe(
      `application/json; version=${REQUESTED_API_VERSION}`
    );
    expect(fetchMock.headerOf(call, "content-type")).toBe("application/json");
  });

  it("passes method and body through and lets callers override headers", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true }));

    await api().request("/documents/1/", {
      method: "PATCH",
      body: JSON.stringify({ title: "x" }),
      headers: { "Content-Type": "application/vnd.custom" },
    });

    const call = fetchMock.only();
    expect(call.init.method).toBe("PATCH");
    expect(call.init.body).toBe('{"title":"x"}');
    expect(fetchMock.headerOf(call, "content-type")).toBe(
      "application/vnd.custom"
    );
    // The override must not drop the credentials or the version negotiation.
    expect(fetchMock.headerOf(call, "authorization")).toBe(`Token ${TOKEN}`);
    expect(fetchMock.headerOf(call, "accept")).toBe(
      `application/json; version=${REQUESTED_API_VERSION}`
    );
  });

  it("returns null for 204 No Content, as DELETE endpoints answer", async () => {
    mockFetch(() => emptyResponse(204));

    await expect(api().deleteTag(7)).resolves.toBeNull();
  });
});

describe("PaperlessAPI.request — HTTP error mapping", () => {
  it("maps a 404 to an error naming the status", async () => {
    mockFetch(() => jsonResponse({ detail: "Not found." }, 404));

    await expect(api().getDocument(9999)).rejects.toThrow(
      "HTTP error! status: 404"
    );
  });

  it("maps a 500 to an error naming the status", async () => {
    mockFetch(() => jsonResponse({ detail: "boom" }, 500));

    await expect(api().getTags()).rejects.toThrow("HTTP error! status: 500");
  });

  it("still reports the status when the error body is not JSON", async () => {
    mockFetch(() => textResponse("<html>502 Bad Gateway</html>", 502));

    await expect(api().getTags()).rejects.toThrow("HTTP error! status: 502");
  });

  it("never writes the API token to the log", async () => {
    mockFetch(() => jsonResponse({ detail: "Invalid token." }, 401));

    await expect(api().getTags()).rejects.toThrow("HTTP error! status: 401");
    expect(loggedText()).not.toContain(TOKEN);
  });
});

describe("PaperlessAPI.request — unsupported API version", () => {
  const notAcceptable = (headers: Record<string, string>) =>
    new Response(
      JSON.stringify({
        detail: 'Invalid version in "Accept" header.',
        instance_hostname: "paperless-internal.example.invalid",
      }),
      { status: 406, headers: { "content-type": "application/json", ...headers } }
    );

  it("throws a PaperlessApiVersionError instead of a bare HTTP error", async () => {
    mockFetch(() =>
      notAcceptable({ "X-Api-Version": "12", "X-Version": "4.0.0" })
    );

    await expect(api().getTags()).rejects.toBeInstanceOf(
      PaperlessApiVersionError
    );
  });

  it("produces an actionable message naming both versions", async () => {
    mockFetch(() =>
      notAcceptable({ "X-Api-Version": "12", "X-Version": "4.0.0" })
    );

    await expect(api().getTags()).rejects.toThrow(
      /refused API version 9 .*Paperless-ngx 4\.0\.0.*Upgrade @smic\/paperless-mcp/s
    );
  });

  it("does not echo the upstream response body into the error", async () => {
    mockFetch(() =>
      notAcceptable({ "X-Api-Version": "12", "X-Version": "4.0.0" })
    );

    const error = await api()
      .getTags()
      .catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("Invalid version");
    expect((error as Error).message).not.toContain(
      "paperless-internal.example.invalid"
    );
  });

  it("does not log the upstream response body or the token", async () => {
    mockFetch(() =>
      notAcceptable({ "X-Api-Version": "12", "X-Version": "4.0.0" })
    );

    await expect(api().getTags()).rejects.toThrow();

    const logged = loggedText();
    expect(logged).not.toContain("paperless-internal.example.invalid");
    expect(logged).not.toContain("Invalid version");
    expect(logged).not.toContain(TOKEN);
    // The actionable message belongs in the thrown error, not in the log; the
    // log carries the structured facts only.
    expect(logged).not.toContain("Upgrade @smic/paperless-mcp");
    expect(logged).toContain("paperless_api_version_unsupported");
    expect(logged).toContain('"requested_api_version\\":9');
    expect(logged).toContain('"server_api_version\\":12');
  });

  it("never inspects the upstream body, it only drains it", async () => {
    let jsonRead = false;
    let drained = false;
    mockFetch(() => {
      const response = notAcceptable({ "X-Api-Version": "12" });
      response.json = async () => {
        jsonRead = true;
        return {};
      };
      const originalText = response.text.bind(response);
      response.text = async () => {
        drained = true;
        return originalText();
      };
      return response;
    });

    await expect(api().getTags()).rejects.toThrow();
    // The body is drained so the connection can be reused, but never parsed,
    // and nothing from it reaches the error or the log.
    expect(jsonRead).toBe(false);
    expect(drained).toBe(true);
    expect(loggedText()).not.toContain("paperless-internal.example.invalid");
  });

  it("tells the operator to upgrade Paperless-ngx when the instance is older than 2.16", async () => {
    mockFetch(() =>
      notAcceptable({ "X-Api-Version": "7", "X-Version": "2.14.0" })
    );

    await expect(api().getTags()).rejects.toThrow(
      /Upgrade Paperless-ngx to 2\.16\.0 or newer/
    );
  });
});

describe("PaperlessAPI — endpoint wiring", () => {
  it("probes readiness through the versioned profile endpoint", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ username: "reader" }));
    const controller = new AbortController();

    await expect(
      api().probeReadiness(controller.signal)
    ).resolves.toBeUndefined();

    const call = fetchMock.only();
    expect(call.url).toBe(`${BASE_URL}/api/profile/`);
    expect(call.init.signal).toBe(controller.signal);
    expect(fetchMock.headerOf(call, "authorization")).toBe(`Token ${TOKEN}`);
    expect(fetchMock.headerOf(call, "accept")).toBe(
      `application/json; version=${REQUESTED_API_VERSION}`
    );
  });

  it("posts document bulk edits to /api/documents/bulk_edit/", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ result: "OK" }));

    await api().bulkEditDocuments([1, 2], "add_tag", { tag: 5 });

    const call = fetchMock.only();
    expect(call.url).toBe(`${BASE_URL}/api/documents/bulk_edit/`);
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(call.init.body as string)).toEqual({
      documents: [1, 2],
      method: "add_tag",
      parameters: { tag: 5 },
    });
  });

  it("posts object bulk edits to /api/bulk_edit_objects/ with the parameters flattened", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ result: "OK" }));

    await api().bulkEditObjects([3], "tags", "set_permissions", { owner: 1 });

    const call = fetchMock.only();
    expect(call.url).toBe(`${BASE_URL}/api/bulk_edit_objects/`);
    expect(JSON.parse(call.init.body as string)).toEqual({
      objects: [3],
      object_type: "tags",
      operation: "set_permissions",
      owner: 1,
    });
  });

  it("PATCHes document updates", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ id: 4 }));

    await api().updateDocument(4, { title: "Synthetic" });

    const call = fetchMock.only();
    expect(call.url).toBe(`${BASE_URL}/api/documents/4/`);
    expect(call.init.method).toBe("PATCH");
    expect(JSON.parse(call.init.body as string)).toEqual({
      title: "Synthetic",
    });
  });

  it("appends the pagination query verbatim to list endpoints", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ results: [] }));

    await api().getTags("?page=2&page_size=50");

    expect(fetchMock.only().url).toBe(
      `${BASE_URL}/api/tags/?page=2&page_size=50`
    );
  });
});

describe("PaperlessAPI.searchDocuments", () => {
  it("encodes the query and pagination parameters", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ count: 0, results: [] }));

    await api().searchDocuments("tag:unpaid AND type:invoice", 2, 50);

    expect(fetchMock.only().url).toBe(
      `${BASE_URL}/api/documents/?query=tag%3Aunpaid+AND+type%3Ainvoice&page=2&page_size=50`
    );
  });

  it("omits pagination parameters that were not supplied", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ count: 0, results: [] }));

    await api().searchDocuments("invoice");

    expect(fetchMock.only().url).toBe(`${BASE_URL}/api/documents/?query=invoice`);
  });

  it("strips the OCR content and long URLs to keep results small", async () => {
    mockFetch(() =>
      jsonResponse({
        count: 1,
        results: [
          {
            id: 42,
            title: "Synthetic",
            content: "x".repeat(10000),
            download_url: "https://paperless.example.invalid/long",
            thumbnail_url: "https://paperless.example.invalid/thumb",
            correspondent: 3,
          },
        ],
      })
    );

    const result: any = await api().searchDocuments("synthetic");

    expect(result.results[0]).toEqual({
      id: 42,
      title: "Synthetic",
      correspondent: 3,
    });
  });

  it("passes through responses that carry no results array", async () => {
    mockFetch(() => jsonResponse({ detail: "no results key" }));

    await expect(api().searchDocuments("x")).resolves.toEqual({
      detail: "no results key",
    });
  });
});
