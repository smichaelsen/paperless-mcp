import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperlessAPI } from "../../src/api/PaperlessAPI";
import { jsonResponse, mockFetch, textResponse } from "../helpers/fetchMock";

const BASE_URL = "https://paperless.example.invalid";
const TOKEN = "s3cr3t-token-value";

const api = () => new PaperlessAPI(BASE_URL, TOKEN);

const syntheticFile = (name = "synthetic.txt") =>
  new File([new Blob(["synthetic fixture"])], name);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PaperlessAPI.postDocument — form-data assembly", () => {
  it("uploads to /api/documents/post_document/ with the file under 'document'", async () => {
    const fetchMock = mockFetch(() => jsonResponse("task-uuid"));

    await api().postDocument(syntheticFile("invoice.pdf"));

    const call = fetchMock.only();
    expect(call.url).toBe(`${BASE_URL}/api/documents/post_document/`);
    expect(call.init.method).toBe("POST");

    const form = call.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const uploaded = form.get("document") as File;
    expect(uploaded).toBeInstanceOf(File);
    expect(uploaded.name).toBe("invoice.pdf");
  });

  it("authenticates but leaves Content-Type to FormData so the boundary is set", async () => {
    const fetchMock = mockFetch(() => jsonResponse("task-uuid"));

    await api().postDocument(syntheticFile());

    const call = fetchMock.only();
    expect(fetchMock.headerOf(call, "authorization")).toBe(`Token ${TOKEN}`);
    expect(fetchMock.headerOf(call, "content-type")).toBeUndefined();
  });

  it("omits metadata fields that were not supplied", async () => {
    const fetchMock = mockFetch(() => jsonResponse("task-uuid"));

    await api().postDocument(syntheticFile());

    const form = fetchMock.only().init.body as FormData;
    expect([...form.keys()]).toEqual(["document"]);
  });

  it("serializes scalar metadata fields", async () => {
    const fetchMock = mockFetch(() => jsonResponse("task-uuid"));

    await api().postDocument(syntheticFile(), {
      title: "Synthetic fixture",
      created: "2026-01-31",
      correspondent: 3 as unknown as string,
      document_type: 4 as unknown as string,
      storage_path: 5 as unknown as string,
      archive_serial_number: "42",
    });

    const form = fetchMock.only().init.body as FormData;
    expect(form.get("title")).toBe("Synthetic fixture");
    expect(form.get("created")).toBe("2026-01-31");
    expect(form.get("correspondent")).toBe("3");
    expect(form.get("document_type")).toBe("4");
    expect(form.get("storage_path")).toBe("5");
    expect(form.get("archive_serial_number")).toBe("42");
  });

  it("appends list metadata once per entry, as Paperless expects", async () => {
    const fetchMock = mockFetch(() => jsonResponse("task-uuid"));

    await api().postDocument(syntheticFile(), {
      tags: [1, 2, 3] as unknown as string[],
      custom_fields: [7, 8] as unknown as string[],
    });

    const form = fetchMock.only().init.body as FormData;
    expect(form.getAll("tags")).toEqual(["1", "2", "3"]);
    expect(form.getAll("custom_fields")).toEqual(["7", "8"]);
  });

  it("maps an upload failure to an error naming the status", async () => {
    mockFetch(() => textResponse("payload too large", 413));

    await expect(api().postDocument(syntheticFile())).rejects.toThrow(
      "HTTP error! status: 413"
    );
  });

  it("does not mistake a 406 on the upload path for an API version rejection", async () => {
    // post_document negotiates no API version, so a 406 there means something
    // else (a proxy, a content-type policy) and must not claim otherwise.
    mockFetch(
      () =>
        new Response("not acceptable", {
          status: 406,
          headers: { "X-Api-Version": "12" },
        })
    );

    await expect(api().postDocument(syntheticFile())).rejects.toThrow(
      "HTTP error! status: 406"
    );
  });

  it("does not put the upstream error body into the thrown error", async () => {
    mockFetch(() =>
      jsonResponse({ detail: "internal path /srv/paperless/media" }, 400)
    );

    const error = await api()
      .postDocument(syntheticFile())
      .catch((caught: Error) => caught);

    expect((error as Error).message).toBe("HTTP error! status: 400");
    expect((error as Error).message).not.toContain("/srv/paperless/media");
  });
});

describe("PaperlessAPI.downloadDocument", () => {
  it("requests the archived version by default", async () => {
    const fetchMock = mockFetch(() => textResponse("pdf-bytes"));

    await api().downloadDocument(42);

    expect(fetchMock.only().url).toBe(
      `${BASE_URL}/api/documents/42/download/`
    );
  });

  it("requests the original file when asked for it", async () => {
    const fetchMock = mockFetch(() => textResponse("pdf-bytes"));

    await api().downloadDocument(42, true);

    expect(fetchMock.only().url).toBe(
      `${BASE_URL}/api/documents/42/download/?original=true`
    );
  });

  it("authenticates the download", async () => {
    const fetchMock = mockFetch(() => textResponse("pdf-bytes"));

    await api().downloadDocument(42);

    expect(fetchMock.headerOf(fetchMock.only(), "authorization")).toBe(
      `Token ${TOKEN}`
    );
  });

  it("returns the raw response so the caller can read bytes and filename", async () => {
    mockFetch(() =>
      textResponse("pdf-bytes", 200, {
        "content-disposition": 'attachment; filename="synthetic.pdf"',
      })
    );

    const response = await api().downloadDocument(42);

    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="synthetic.pdf"'
    );
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "pdf-bytes"
    );
  });

  it("throws on an error status instead of base64-encoding the error page", async () => {
    mockFetch(() => textResponse("Not found", 404));

    await expect(api().downloadDocument(9999)).rejects.toThrow(
      "HTTP error! status: 404"
    );
  });

  it("does not put the upstream error page into the thrown error", async () => {
    mockFetch(() => textResponse("<html>internal-host.example.invalid</html>", 404));

    const error = await api()
      .downloadDocument(9999)
      .catch((caught: Error) => caught);

    expect((error as Error).message).toBe("HTTP error! status: 404");
    expect((error as Error).message).not.toContain("internal-host");
  });
});
