/**
 * Opt-in integration tests against a real, disposable Paperless-ngx instance.
 *
 * They are skipped unless PAPERLESS_TEST_URL is set, so `npm test` stays
 * hermetic and CI never depends on a live server. See the README section
 * "Integration tests" for how to run them.
 *
 * Everything these tests create is prefixed with `mcp-it-` and removed again in
 * the cleanup hook. They never touch pre-existing objects.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PaperlessAPI } from "../../src/api/PaperlessAPI";
import {
  REQUESTED_API_VERSION,
  buildApiVersionError,
  isApiVersionRejection,
  readServerApiVersion,
} from "../../src/api/apiVersion";

const baseUrl = process.env.PAPERLESS_TEST_URL?.replace(/\/+$/, "");
const token = process.env.PAPERLESS_TEST_TOKEN;
const uploadEnabled = process.env.PAPERLESS_TEST_UPLOAD === "1";

const enabled = Boolean(baseUrl);

/** Unique per run so parallel runs against one instance cannot collide. */
const runId = `mcp-it-${randomUUID().slice(0, 8)}`;
const fixtureName = (what: string) => `${runId}-${what}`;

const createdTags: number[] = [];
const createdCorrespondents: number[] = [];
const createdDocumentTypes: number[] = [];
const createdDocuments: number[] = [];

let api: PaperlessAPI;

describe.skipIf(!enabled)("Paperless-ngx integration", () => {
  beforeAll(() => {
    if (!token) {
      throw new Error(
        "PAPERLESS_TEST_URL is set but PAPERLESS_TEST_TOKEN is missing. Both are required to run the integration tests."
      );
    }
    api = new PaperlessAPI(baseUrl!, token);
  });

  afterAll(async () => {
    if (!api) return;
    // Best-effort cleanup: never let a cleanup failure mask a test failure.
    const attempt = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        console.warn(
          `integration cleanup failed for ${label}: ${(error as Error).message}`
        );
      }
    };

    if (createdDocuments.length) {
      await attempt("documents", () =>
        api.bulkEditDocuments(createdDocuments, "delete")
      );
    }
    if (createdTags.length) {
      await attempt("tags", () =>
        api.bulkEditObjects(createdTags, "tags", "delete")
      );
    }
    if (createdCorrespondents.length) {
      await attempt("correspondents", () =>
        api.bulkEditObjects(createdCorrespondents, "correspondents", "delete")
      );
    }
    if (createdDocumentTypes.length) {
      await attempt("document types", () =>
        api.bulkEditObjects(createdDocumentTypes, "document_types", "delete")
      );
    }
  });

  describe("API version negotiation", () => {
    it("offers at least the API version this client requests", async () => {
      const response = await fetch(`${baseUrl}/api/documents/?page_size=1`, {
        headers: {
          Authorization: `Token ${token}`,
          Accept: `application/json; version=${REQUESTED_API_VERSION}`,
        },
      });

      expect(response.status).toBe(200);
      const serverApiVersion = readServerApiVersion(response.headers);
      expect(serverApiVersion).not.toBeNull();
      expect(serverApiVersion!).toBeGreaterThanOrEqual(REQUESTED_API_VERSION);
    });

    it("rejects an unsupported API version, and we report it without upstream data", async () => {
      const response = await fetch(`${baseUrl}/api/documents/?page_size=1`, {
        headers: {
          Authorization: `Token ${token}`,
          Accept: "application/json; version=1",
        },
      });

      expect(isApiVersionRejection(response.status)).toBe(true);

      const error = buildApiVersionError(response.headers);
      expect(error.message).toContain("refused API version 9");
      expect(error.message).toContain("The upstream response body was not read");

      // Whatever the instance said in the body must not appear in our error.
      const upstreamBody = await response.text();
      expect(upstreamBody.length).toBeGreaterThan(0);
      expect(error.message).not.toContain(upstreamBody);
    });
  });

  describe("read-only workflow", () => {
    it("lists documents with pagination", async () => {
      const page: any = await api.getDocuments("?page=1&page_size=2");
      expect(page).toHaveProperty("count");
      expect(Array.isArray(page.results)).toBe(true);
      expect(page.results.length).toBeLessThanOrEqual(2);
    });

    it("lists tags, correspondents and document types", async () => {
      for (const list of [
        api.getTags("?page_size=2"),
        api.getCorrespondents("?page_size=2"),
        api.getDocumentTypes("?page_size=2"),
      ]) {
        const page: any = await list;
        expect(Array.isArray(page.results)).toBe(true);
      }
    });

    it("searches documents without returning the OCR content", async () => {
      const result: any = await api.searchDocuments(runId, 1, 5);
      expect(result).toHaveProperty("count");
      for (const document of result.results ?? []) {
        expect(document).not.toHaveProperty("content");
        expect(document).not.toHaveProperty("download_url");
      }
    });
  });

  describe("synthetic tag lifecycle", () => {
    let tagId: number;

    it("creates a synthetic tag", async () => {
      const tag: any = await api.createTag({
        name: fixtureName("tag"),
        color: "#a6cee3",
      });
      tagId = tag.id;
      createdTags.push(tagId);
      expect(tag.name).toBe(fixtureName("tag"));
    });

    it("reads the tag back by id", async () => {
      const tag: any = await api.getTag(tagId);
      expect(tag.id).toBe(tagId);
      expect(tag.color.toLowerCase()).toBe("#a6cee3");
    });

    it("updates the tag", async () => {
      const updated: any = await api.updateTag(tagId, {
        name: fixtureName("tag-renamed"),
        color: "#b2df8a",
      });
      expect(updated.name).toBe(fixtureName("tag-renamed"));
    });

    it("deletes the tag and stops listing it", async () => {
      await expect(api.deleteTag(tagId)).resolves.toBeNull();
      createdTags.splice(createdTags.indexOf(tagId), 1);

      const page: any = await api.getTags(
        `?name__iexact=${encodeURIComponent(fixtureName("tag-renamed"))}`
      );
      expect(page.count).toBe(0);
    });
  });

  describe("synthetic correspondent and document type lifecycle", () => {
    it("creates and bulk-deletes a correspondent", async () => {
      const correspondent: any = await api.createCorrespondent({
        name: fixtureName("correspondent"),
      });
      createdCorrespondents.push(correspondent.id);

      expect((await api.getCorrespondent(correspondent.id)) as any).toHaveProperty(
        "id",
        correspondent.id
      );

      await api.bulkEditObjects(
        [correspondent.id],
        "correspondents",
        "delete"
      );
      createdCorrespondents.splice(
        createdCorrespondents.indexOf(correspondent.id),
        1
      );

      const page: any = await api.getCorrespondents(
        `?name__iexact=${encodeURIComponent(fixtureName("correspondent"))}`
      );
      expect(page.count).toBe(0);
    });

    it("creates and bulk-deletes a document type", async () => {
      const documentType: any = await api.createDocumentType({
        name: fixtureName("doctype"),
      });
      createdDocumentTypes.push(documentType.id);

      expect((await api.getDocumentType(documentType.id)) as any).toHaveProperty(
        "id",
        documentType.id
      );

      await api.bulkEditObjects([documentType.id], "document_types", "delete");
      createdDocumentTypes.splice(
        createdDocumentTypes.indexOf(documentType.id),
        1
      );

      const page: any = await api.getDocumentTypes(
        `?name__iexact=${encodeURIComponent(fixtureName("doctype"))}`
      );
      expect(page.count).toBe(0);
    });
  });

  // Uploading needs a running consumer on the instance, so it is gated
  // separately: set PAPERLESS_TEST_UPLOAD=1 to include it.
  describe.skipIf(!uploadEnabled)("synthetic document lifecycle", () => {
    const title = fixtureName("document");

    it(
      "uploads, updates and deletes a synthetic document",
      async () => {
        const file = new File(
          [new Blob([`Synthetic fixture for ${runId}. Safe to delete.\n`])],
          `${title}.txt`,
          { type: "text/plain" }
        );

        await api.postDocument(file, { title });

        // Consumption is asynchronous; poll for the document by title.
        const deadline = Date.now() + 120_000;
        let documentId: number | undefined;
        while (Date.now() < deadline && documentId === undefined) {
          const page: any = await api.getDocuments(
            `?title__icontains=${encodeURIComponent(title)}`
          );
          documentId = page.results?.[0]?.id;
          if (documentId === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
        }

        expect(
          documentId,
          "uploaded document was not consumed within 120s — is the consumer running?"
        ).toBeDefined();
        createdDocuments.push(documentId!);

        const updated: any = await api.updateDocument(documentId!, {
          title: `${title}-renamed`,
        });
        expect(updated.title).toBe(`${title}-renamed`);

        const download = await api.downloadDocument(documentId!, true);
        expect(download.ok).toBe(true);
        expect((await download.text()).length).toBeGreaterThan(0);

        await api.bulkEditDocuments([documentId!], "delete");
        createdDocuments.splice(createdDocuments.indexOf(documentId!), 1);
      },
      180_000
    );
  });
});
