import { afterEach, describe, expect, it } from "vitest";
import { clearRegisteredSecrets, redact } from "../../src/logging";
import { registerCorrespondentTools } from "../../src/tools/correspondents";
import { registerDocumentTools } from "../../src/tools/documents";
import { registerDocumentTypeTools } from "../../src/tools/documentTypes";
import { registerTagTools } from "../../src/tools/tags";
import { createApiStub, createFakeServer } from "../helpers/fakeServer";

const EXPECTED_TOOLS = [
  "bulk_edit_documents",
  "post_document",
  "get_document",
  "update_document",
  "search_documents",
  "download_document",
  "get_document_download_link",
  "create_public_document_share_link",
  "list_tags",
  "get_tag",
  "create_tag",
  "update_tag",
  "delete_tag",
  "bulk_edit_tags",
  "list_correspondents",
  "get_correspondent",
  "create_correspondent",
  "bulk_edit_correspondents",
  "list_document_types",
  "get_document_type",
  "create_document_type",
  "bulk_edit_document_types",
];

function registerAll(
  api: unknown,
  browserUrl = new URL("https://browser.example")
) {
  const fake = createFakeServer();
  registerDocumentTools(fake.server, api, browserUrl);
  registerTagTools(fake.server, api);
  registerCorrespondentTools(fake.server, api);
  registerDocumentTypeTools(fake.server, api);
  return fake;
}

/** Minimal valid arguments per tool, used for the handler smoke tests. */
const SMOKE_ARGS: Record<string, Record<string, unknown>> = {
  bulk_edit_documents: { documents: [1], method: "delete" },
  post_document: {
    file: Buffer.from("synthetic").toString("base64"),
    filename: "synthetic.txt",
  },
  get_document: { id: 1 },
  update_document: { id: 1, title: "Synthetic" },
  search_documents: { query: "synthetic" },
  download_document: { id: 1 },
  get_document_download_link: { id: 1 },
  create_public_document_share_link: { id: 1, expiration_days: 1 },
  list_tags: {},
  get_tag: { id: 1 },
  create_tag: { name: "synthetic" },
  update_tag: { id: 1, name: "synthetic" },
  delete_tag: { id: 1 },
  bulk_edit_tags: { tag_ids: [1], operation: "delete" },
  list_correspondents: {},
  get_correspondent: { id: 1 },
  create_correspondent: { name: "synthetic" },
  bulk_edit_correspondents: { correspondent_ids: [1], operation: "delete" },
  list_document_types: {},
  get_document_type: { id: 1 },
  create_document_type: { name: "synthetic" },
  bulk_edit_document_types: { document_type_ids: [1], operation: "delete" },
};

const downloadStub = () =>
  createApiStub({
    downloadDocument: async () =>
      new Response("pdf-bytes", {
        headers: { "content-disposition": 'attachment; filename="a.pdf"' },
      }),
    createDocumentShareLink: async () => ({
      id: 99,
      expiration: "2026-09-16T12:00:00.000Z",
      slug: "opaque-share-slug",
      file_version: "archive",
    }),
  });

afterEach(() => {
  clearRegisteredSecrets();
});

describe("tool registration", () => {
  it("registers the documented tool surface, and nothing else", () => {
    const fake = registerAll(createApiStub().api);
    expect(fake.names().sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("gives every tool a description", () => {
    const fake = registerAll(createApiStub().api);
    for (const tool of fake.tools.values()) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
    }
  });

  it("describes every declared argument, so clients can use them unaided", () => {
    const fake = registerAll(createApiStub().api);
    for (const tool of fake.tools.values()) {
      for (const [field, schema] of Object.entries(tool.shape)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });
});

describe("argument validation", () => {
  const fake = registerAll(createApiStub().api);

  it("accepts a well-formed create_tag call", () => {
    const result = fake.get("create_tag").parse({
      name: "synthetic",
      color: "#a6cee3",
      match: "invoice",
      matching_algorithm: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a tag color that is not a hex triplet", () => {
    expect(fake.get("create_tag").parse({ name: "x", color: "red" }).success).toBe(
      false
    );
    expect(
      fake.get("create_tag").parse({ name: "x", color: "#abc" }).success
    ).toBe(false);
  });

  it("rejects a matching algorithm outside the Paperless range", () => {
    expect(
      fake.get("create_tag").parse({ name: "x", matching_algorithm: 5 }).success
    ).toBe(false);
    expect(
      fake.get("create_tag").parse({ name: "x", matching_algorithm: 1.5 })
        .success
    ).toBe(false);
  });

  it("requires a tag name", () => {
    expect(fake.get("create_tag").parse({}).success).toBe(false);
    expect(fake.get("create_tag").parse({ name: 7 }).success).toBe(false);
  });

  it("requires a numeric id for get_document", () => {
    expect(fake.get("get_document").parse({ id: 1 }).success).toBe(true);
    expect(fake.get("get_document").parse({ id: "1" }).success).toBe(false);
    expect(fake.get("get_document").parse({}).success).toBe(false);
  });

  it("requires a bounded expiration and restricts public shares to archive or original", () => {
    const tool = fake.get("create_public_document_share_link");

    expect(tool.parse({ id: 1, expiration_days: 1 }).success).toBe(true);
    expect(
      tool.parse({ id: 1, expiration_days: 7, file_version: "original" })
        .success
    ).toBe(true);
    for (const expiration_days of [undefined, 0, 8, 1.5]) {
      expect(tool.parse({ id: 1, expiration_days }).success).toBe(false);
    }
    expect(
      tool.parse({ id: 1, expiration_days: 1, file_version: "thumbnail" })
        .success
    ).toBe(false);
  });

  it("allows update_document to clear nullable relations but not to invent fields", () => {
    const ok = fake.get("update_document").parse({
      id: 1,
      correspondent: null,
      document_type: null,
      archive_serial_number: null,
      tags: [1, 2],
      created: "2026-01-31",
    });
    expect(ok.success).toBe(true);

    const stripped = fake
      .get("update_document")
      .parse({ id: 1, title: "x", not_a_field: true });
    expect(stripped.success).toBe(true);
    expect(stripped.success && stripped.data).not.toHaveProperty("not_a_field");
  });

  it("rejects an unknown bulk edit method", () => {
    expect(
      fake
        .get("bulk_edit_documents")
        .parse({ documents: [1], method: "set_correspondent" }).success
    ).toBe(true);
    expect(
      fake.get("bulk_edit_documents").parse({ documents: [1], method: "nuke" })
        .success
    ).toBe(false);
    expect(
      fake
        .get("bulk_edit_documents")
        .parse({ documents: ["1"], method: "delete" }).success
    ).toBe(false);
  });

  it("restricts object bulk edits to set_permissions and delete", () => {
    expect(
      fake.get("bulk_edit_tags").parse({ tag_ids: [1], operation: "delete" })
        .success
    ).toBe(true);
    expect(
      fake.get("bulk_edit_tags").parse({ tag_ids: [1], operation: "merge" })
        .success
    ).toBe(false);
  });

  it("validates the shared pagination arguments on every list tool", () => {
    for (const name of [
      "list_tags",
      "list_correspondents",
      "list_document_types",
    ]) {
      const tool = fake.get(name);
      expect(tool.parse({}).success, name).toBe(true);
      expect(tool.parse({ page: 1, page_size: 1000 }).success, name).toBe(true);
      expect(tool.parse({ page: 0 }).success, name).toBe(false);
      expect(tool.parse({ page: 1.5 }).success, name).toBe(false);
      expect(tool.parse({ page_size: 0 }).success, name).toBe(false);
      expect(tool.parse({ page_size: 100001 }).success, name).toBe(false);
      expect(tool.parse({ page: "2" }).success, name).toBe(false);
    }
  });

  it("requires both the base64 payload and the filename for post_document", () => {
    expect(
      fake.get("post_document").parse({ file: "Zm9v", filename: "a.txt" })
        .success
    ).toBe(true);
    expect(fake.get("post_document").parse({ file: "Zm9v" }).success).toBe(
      false
    );
    expect(fake.get("post_document").parse({ filename: "a.txt" }).success).toBe(
      false
    );
  });

  it("uses the Paperless string matching algorithms for correspondents and document types", () => {
    expect(
      fake
        .get("create_correspondent")
        .parse({ name: "x", matching_algorithm: "fuzzy" }).success
    ).toBe(true);
    expect(
      fake.get("create_correspondent").parse({ name: "x", matching_algorithm: 4 })
        .success
    ).toBe(false);
    expect(
      fake
        .get("create_document_type")
        .parse({ name: "x", matching_algorithm: "regular expression" }).success
    ).toBe(true);
  });
});

describe("handler results", () => {
  it("wraps every tool result in an MCP text content block", async () => {
    const fake = registerAll(downloadStub().api);

    for (const name of EXPECTED_TOOLS) {
      const result = await fake.get(name).handler(SMOKE_ARGS[name], {});
      expect(Array.isArray(result.content), name).toBe(true);
      expect(result.content[0].type, name).toBe("text");
      expect(typeof result.content[0].text, name).toBe("string");
      expect(() => JSON.parse(result.content[0].text), name).not.toThrow();
    }
  });

  it("fails clearly when no API connection was configured", async () => {
    const fake = registerAll(null);

    for (const name of EXPECTED_TOOLS) {
      await expect(
        fake.get(name).handler(SMOKE_ARGS[name], {}),
        name
      ).rejects.toThrow("Please configure API connection first");
    }
  });
});

describe("handler behaviour", () => {
  it("forwards pagination to the list endpoints as a query string", async () => {
    const stub = createApiStub();
    const fake = registerAll(stub.api);

    await fake.get("list_tags").handler({ page: 3, page_size: 50 }, {});
    expect(stub.lastCall()).toEqual({
      method: "getTags",
      args: ["?page=3&page_size=50"],
    });

    await fake.get("list_correspondents").handler({}, {});
    expect(stub.lastCall()).toEqual({ method: "getCorrespondents", args: [""] });
  });

  it("refuses an update_document call that would change nothing", async () => {
    const stub = createApiStub();
    const fake = registerAll(stub.api);

    await expect(
      fake.get("update_document").handler({ id: 1 }, {})
    ).rejects.toThrow("At least one field must be provided to update.");
    expect(stub.calls).toHaveLength(0);
  });

  it("splits bulk_edit_documents arguments into method and parameters", async () => {
    const stub = createApiStub();
    const fake = registerAll(stub.api);

    await fake
      .get("bulk_edit_documents")
      .handler({ documents: [1, 2], method: "add_tag", tag: 5 }, {});

    expect(stub.lastCall()).toEqual({
      method: "bulkEditDocuments",
      args: [[1, 2], "add_tag", { tag: 5 }],
    });
  });

  it("sends no permission parameters when bulk deleting objects", async () => {
    const stub = createApiStub();
    const fake = registerAll(stub.api);

    await fake
      .get("bulk_edit_tags")
      .handler({ tag_ids: [4], operation: "delete", owner: 1 }, {});

    expect(stub.lastCall()).toEqual({
      method: "bulkEditObjects",
      args: [[4], "tags", "delete", {}],
    });
  });

  it("passes owner and permissions when bulk setting permissions", async () => {
    const stub = createApiStub();
    const fake = registerAll(stub.api);

    await fake.get("bulk_edit_correspondents").handler(
      {
        correspondent_ids: [4],
        operation: "set_permissions",
        owner: 2,
        merge: true,
      },
      {}
    );

    expect(stub.lastCall()).toEqual({
      method: "bulkEditObjects",
      args: [
        [4],
        "correspondents",
        "set_permissions",
        { owner: 2, permissions: undefined, merge: true },
      ],
    });
  });

  it("decodes the base64 upload into a named file", async () => {
    const stub = createApiStub();
    const fake = registerAll(stub.api);

    await fake.get("post_document").handler(
      {
        file: Buffer.from("synthetic fixture").toString("base64"),
        filename: "synthetic.txt",
        title: "Synthetic",
        tags: [1],
      },
      {}
    );

    const [file, metadata] = stub.lastCall().args;
    expect(stub.lastCall().method).toBe("postDocument");
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("synthetic.txt");
    expect(await file.text()).toBe("synthetic fixture");
    expect(metadata).toEqual({ title: "Synthetic", tags: [1] });
  });

  it("base64-encodes a download and takes the filename from content-disposition", async () => {
    const fake = registerAll(
      createApiStub({
        downloadDocument: async () =>
          new Response("pdf-bytes", {
            headers: {
              "content-disposition": 'attachment; filename="synthetic.pdf"',
            },
          }),
      }).api
    );

    const result = await fake.get("download_document").handler({ id: 7 }, {});
    const payload = JSON.parse(result.content[0].text);

    expect(Buffer.from(payload.blob, "base64").toString()).toBe("pdf-bytes");
    expect(payload.filename).toBe("synthetic.pdf");
  });

  it("falls back to document-<id> when no filename is offered", async () => {
    const fake = registerAll(
      createApiStub({
        downloadDocument: async () => new Response("pdf-bytes"),
      }).api
    );

    const result = await fake.get("download_document").handler({ id: 7 }, {});
    expect(JSON.parse(result.content[0].text).filename).toBe("document-7");
  });

  it("returns an archived browser link only after checking document access", async () => {
    const stub = createApiStub({
      getDocument: async () => ({ id: 7, title: "not returned" }),
    });
    const fake = registerAll(
      stub.api,
      new URL("https://paperless.example/sub-path/")
    );

    const result = await fake
      .get("get_document_download_link")
      .handler({ id: 7 }, {});

    expect(stub.calls).toEqual([{ method: "getDocument", args: [7] }]);
    expect(JSON.parse(result.content[0].text)).toEqual({
      url: "https://paperless.example/sub-path/api/documents/7/download/",
      original: false,
      requires_browser_session: true,
    });
    expect(result.content[0].text).not.toContain("not returned");
  });

  it("returns the original browser link when requested", async () => {
    const fake = registerAll(
      createApiStub().api,
      new URL("https://paperless.example")
    );

    const result = await fake
      .get("get_document_download_link")
      .handler({ id: 7, original: true }, {});

    expect(JSON.parse(result.content[0].text)).toEqual({
      url: "https://paperless.example/api/documents/7/download/?original=true",
      original: true,
      requires_browser_session: true,
    });
  });

  it("does not return a link when Paperless denies document access", async () => {
    const denied = new Error("HTTP error! status: 404");
    const fake = registerAll(
      createApiStub({
        getDocument: async () => {
          throw denied;
        },
      }).api,
      new URL("https://paperless.example")
    );

    await expect(
      fake.get("get_document_download_link").handler({ id: 7 }, {})
    ).rejects.toBe(denied);
  });

  it("fails safely without falling back to the API URL", async () => {
    const internalUrl = "http://paperless.internal:8000";
    const stub = createApiStub();
    const fake = createFakeServer();
    registerDocumentTools(fake.server, stub.api);

    let error: unknown;
    try {
      await fake.get("get_document_download_link").handler({ id: 7 }, {});
    } catch (caught) {
      error = caught;
    }

    expect(String(error)).toContain("PAPERLESS_BROWSER_URL");
    expect(String(error)).not.toContain(internalUrl);
    expect(stub.calls).toEqual([]);
  });

  it("also refuses a public share when the browser URL is absent", async () => {
    const stub = createApiStub();
    const fake = createFakeServer();
    registerDocumentTools(fake.server, stub.api);

    await expect(
      fake
        .get("create_public_document_share_link")
        .handler({ id: 7, expiration_days: 1 }, {})
    ).rejects.toThrow("PAPERLESS_BROWSER_URL");
    expect(stub.calls).toEqual([]);
  });

  it("creates a bounded archive share only after checking document access", async () => {
    const slug = "archive-share-bearer-slug";
    const expiresAt = "2026-09-22T12:00:00.000Z";
    const stub = createApiStub({
      getDocument: async () => ({ id: 7 }),
      createDocumentShareLink: async () => ({
        id: 123,
        expiration: expiresAt,
        slug,
        file_version: "archive",
      }),
    });
    const fake = registerAll(
      stub.api,
      new URL("https://paperless.example/sub-path/")
    );
    const before = Date.now();

    const result = await fake
      .get("create_public_document_share_link")
      .handler({ id: 7, expiration_days: 7 }, {});

    expect(stub.calls[0]).toEqual({ method: "getDocument", args: [7] });
    expect(stub.calls[1].method).toBe("createDocumentShareLink");
    expect(stub.calls[1].args.slice(0, 2)).toEqual([7, "archive"]);
    const requestedExpiration = Date.parse(stub.calls[1].args[2]);
    expect(requestedExpiration).toBeGreaterThanOrEqual(
      before + 7 * 24 * 60 * 60 * 1000
    );
    expect(requestedExpiration).toBeLessThanOrEqual(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toEqual({
      url: `https://paperless.example/sub-path/share/${slug}`,
      share_link_id: 123,
      file_version: "archive",
      expires_at: expiresAt,
    });

    // Slugs and full URLs are bearer credentials and must be scrubbed even if
    // a future caller mistakenly tries to log the returned payload.
    const scrubbed = redact(`${slug} ${payload.url}`);
    expect(scrubbed).not.toContain(slug);
    expect(scrubbed).not.toContain(payload.url);
  });

  it("creates an original-file share when explicitly requested", async () => {
    const stub = createApiStub({
      createDocumentShareLink: async () => ({
        id: 124,
        expiration: "2026-09-16T12:00:00.000Z",
        slug: "original-share-bearer-slug",
        file_version: "original",
      }),
    });
    const fake = registerAll(stub.api);

    const result = await fake
      .get("create_public_document_share_link")
      .handler(
        { id: 8, expiration_days: 1, file_version: "original" },
        {}
      );

    expect(stub.calls[1].args[1]).toBe("original");
    expect(JSON.parse(result.content[0].text).file_version).toBe("original");
  });

  it("returns no partial public URL when access or creation fails", async () => {
    const accessDenied = new Error("HTTP error! status: 404");
    const denied = createApiStub({
      getDocument: async () => {
        throw accessDenied;
      },
    });
    const deniedTool = registerAll(denied.api).get(
      "create_public_document_share_link"
    );
    await expect(
      deniedTool.handler({ id: 7, expiration_days: 1 }, {})
    ).rejects.toBe(accessDenied);
    expect(denied.calls).toEqual([{ method: "getDocument", args: [7] }]);

    const createFailed = new Error("HTTP error! status: 403");
    const failed = createApiStub({
      createDocumentShareLink: async () => {
        throw createFailed;
      },
    });
    const failedTool = registerAll(failed.api).get(
      "create_public_document_share_link"
    );
    await expect(
      failedTool.handler({ id: 7, expiration_days: 1 }, {})
    ).rejects.toBe(createFailed);
    expect(failed.calls.map((call) => call.method)).toEqual([
      "getDocument",
      "createDocumentShareLink",
    ]);
  });

  it("rejects an invalid Paperless response without reflecting its slug", async () => {
    const secretSlug = "malformed-secret-share-slug";
    const fake = registerAll(
      createApiStub({
        createDocumentShareLink: async () => ({ slug: secretSlug }),
      }).api
    );

    let error: unknown;
    try {
      await fake
        .get("create_public_document_share_link")
        .handler({ id: 7, expiration_days: 1 }, {});
    } catch (caught) {
      error = caught;
    }

    expect(String(error)).toBe(
      "Error: Paperless returned an invalid share-link response."
    );
    expect(String(error)).not.toContain(secretSlug);
  });
});
