/**
 * Integration tests against a real, disposable Paperless-ngx instance.
 *
 * They are skipped unless PAPERLESS_TEST_URL is set, so `npm test` on a laptop
 * stays hermetic. CI stands up a throwaway instance (see
 * `compose.integration.yaml` and `scripts/integration-stack.sh`) and sets the
 * variables; the README section "Integration tests" documents the local path.
 *
 * Everything these tests create is prefixed with `mcp-it-` and deleted again in
 * the cleanup hook. They never touch pre-existing objects.
 *
 * One caveat about "deleted", because it matters if you ever point this at an
 * instance you keep: tags, correspondents and document types really are gone,
 * but Paperless **soft-deletes documents**. A deleted document moves to the
 * trash, where it stops being listed and returns 404 from the API — which is
 * what these tests assert — and is only erased when the trash is emptied,
 * after PAPERLESS_EMPTY_TRASH_DELAY days or on demand. The disposable stack in
 * `compose.integration.yaml` disables the trash-emptying task outright and
 * throws the whole container away instead, so nothing accumulates there. On a
 * long-lived instance, document fixtures will sit in the trash until it is
 * emptied.
 *
 * What belongs in this file is the narrow set of claims that only a live server
 * can settle — the ones where a mock would simply answer whatever the client
 * asked for. Above all: that the *names* we put on the wire are the names
 * Paperless actually honours. A wrong query parameter does not fail loudly, it
 * returns a plausible page of the wrong documents, and no amount of mocking
 * will ever notice.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PaperlessAPI } from "../../src/api/PaperlessAPI";
import {
  ACCEPT_HEADER,
  REQUESTED_API_VERSION,
  buildApiVersionError,
  isApiVersionRejection,
  readServerApiVersion,
  readServerVersion,
} from "../../src/api/apiVersion";
import {
  buildBulkEditParameters,
  registerDocumentTools,
} from "../../src/tools/documents";
import { createFakeServer } from "../helpers/fakeServer";

const baseUrl = process.env.PAPERLESS_TEST_URL?.replace(/\/+$/, "");
const token = process.env.PAPERLESS_TEST_TOKEN;
const uploadEnabled = process.env.PAPERLESS_TEST_UPLOAD === "1";
/** Set by the CI lane to the tag it booted, so the matrix cannot lie. */
const expectedServerVersion = process.env.PAPERLESS_TEST_PAPERLESS_VERSION;

const enabled = Boolean(baseUrl);

/** Unique per run so parallel runs against one instance cannot collide. */
const runId = `mcp-it-${randomUUID().slice(0, 8)}`;
const fixtureName = (what: string) => `${runId}-${what}`;

/**
 * A single alphanumeric token that exists nowhere else on the instance. It has
 * to survive the full-text analyser intact, which `mcp-it-1a2b` would not:
 * the tokenizer splits on the hyphens and the search stops being unique.
 */
const searchNonce = `mcpit${randomUUID().replace(/-/g, "").slice(0, 12)}`;

/**
 * Every `method` the `bulk_edit_documents` tool advertises, read out of the
 * committed tool snapshot rather than copied into a list here.
 *
 * #12's review flagged that API v10 moved merge/rotate/edit_pdf onto their own
 * endpoints and deprecated the bulk path this client still uses, which makes
 * that enum a standing claim about the server. A hand-maintained copy would
 * drift the first time someone adds a method to the tool and forgets this
 * file — and the new method would then be the one nothing checked. Taking it
 * from the snapshot means the live coverage follows the advertised surface
 * automatically.
 */
const advertisedBulkEditMethods: string[] = (() => {
  const snapshot = new URL(
    "../tools/__snapshots__/tools-list.destructive.json",
    import.meta.url
  );
  const tools = JSON.parse(readFileSync(snapshot, "utf8"));
  const methods = tools.find((tool: any) => tool.name === "bulk_edit_documents")
    ?.inputSchema?.properties?.method?.enum;
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new Error(
      "could not read the bulk_edit_documents method enum out of tests/tools/__snapshots__/tools-list.destructive.json"
    );
  }
  return methods;
})();

const createdTags: number[] = [];
const createdCorrespondents: number[] = [];
const createdDocumentTypes: number[] = [];
const createdDocuments: number[] = [];
const createdShareLinks: number[] = [];
const createdUsers: number[] = [];

let api: PaperlessAPI;

/**
 * A request that bypasses PaperlessAPI on purpose. The client deliberately
 * hides status codes and never reads a response body, which is right for
 * production and useless for asserting *what the server actually sent*. Tests
 * that need the wire-level truth use this; everything else goes through the
 * client, because the client is what is under test.
 */
async function rawRequest(
  path: string,
  init: RequestInit = {},
  accept: string = ACCEPT_HEADER
): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      Authorization: `Token ${token}`,
      Accept: accept,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

async function tokenFor(username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(response.status).toBe(200);
  const payload: any = await response.json();
  expect(payload.token).toEqual(expect.any(String));
  return payload.token;
}

async function createPrincipal(
  label: string,
  permissions: string[]
): Promise<{ api: PaperlessAPI; id: number }> {
  const username = fixtureName(label);
  const password = `Mcp-It-${randomUUID()}!`;
  const response = await rawRequest("/users/", {
    method: "POST",
    body: JSON.stringify({
      username,
      password,
      email: `${username}@example.invalid`,
      is_active: true,
      user_permissions: permissions,
    }),
  });
  expect(response.status).toBe(201);
  const user: any = await response.json();
  createdUsers.push(user.id);
  expect(user.user_permissions).toEqual(expect.arrayContaining(permissions));
  return {
    api: new PaperlessAPI(baseUrl!, await tokenFor(username, password)),
    id: user.id,
  };
}

function publicShareTool(principal: PaperlessAPI) {
  const fake = createFakeServer();
  registerDocumentTools(fake.server, principal, new URL(baseUrl!));
  return fake.get("create_public_document_share_link");
}

async function activeShareLinkIds(documentId: number): Promise<number[]> {
  const response = await rawRequest(`/documents/${documentId}/share_links/`);
  expect(response.status).toBe(200);
  const links: any[] = await response.json();
  return links.map((link) => link.id).sort((a, b) => a - b);
}

/**
 * Poll until `probe` returns something truthy, or fail with a message that says
 * what was being waited for and for how long. Used only where Paperless is
 * genuinely asynchronous — consumption and full-text indexing run in a Celery
 * worker — and never as a substitute for an assertion.
 */
async function poll<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${what}` +
      (lastError ? ` (last error: ${(lastError as Error).message})` : "")
  );
}

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

    for (const shareLinkId of createdShareLinks) {
      await attempt(`share link ${shareLinkId}`, async () => {
        const response = await rawRequest(`/share_links/${shareLinkId}/`, {
          method: "DELETE",
        });
        if (response.status !== 204 && response.status !== 404) {
          throw new Error(`HTTP ${response.status}`);
        }
      });
    }
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
    for (const userId of createdUsers) {
      await attempt(`user ${userId}`, async () => {
        const response = await rawRequest(`/users/${userId}/`, {
          method: "DELETE",
        });
        if (response.status !== 204 && response.status !== 404) {
          throw new Error(`HTTP ${response.status}`);
        }
      });
    }
  });

  describe("API version negotiation", () => {
    it("serves the endpoint used by the readiness probe", async () => {
      // Exercise the production probe method, not a copied raw request. This
      // keeps the live assertion tied to whatever `/readyz` actually asks and
      // catches endpoints that reject the client's versioned Accept header.
      await expect(
        api.probeReadiness(new AbortController().signal)
      ).resolves.toBeUndefined();
    });

    it("serves the API version this client requests, and says which it offers", async () => {
      const response = await rawRequest("/documents/?page_size=1");

      expect(response.status).toBe(200);
      const serverApiVersion = readServerApiVersion(response.headers);
      const serverVersion = readServerVersion(response.headers);

      // Printed rather than only asserted: the point of this lane is to learn
      // what real instances report, and the run log is where that is recorded.
      console.info(
        `[integration] Paperless-ngx ${serverVersion ?? "?"} — X-Api-Version: ${
          serverApiVersion ?? "?"
        }, client requests version ${REQUESTED_API_VERSION}`
      );

      expect(serverApiVersion).not.toBeNull();
      expect(serverApiVersion!).toBeGreaterThanOrEqual(REQUESTED_API_VERSION);
      expect(serverVersion).not.toBeNull();
      await response.text();
    });

    it.skipIf(!expectedServerVersion)(
      "is the Paperless-ngx release the lane claims to be testing",
      async () => {
        // Without this, a matrix leg that silently booted the wrong tag would
        // still go green and the "supported versions" claim would be untested.
        const response = await rawRequest("/documents/?page_size=1");
        expect(readServerVersion(response.headers)).toBe(expectedServerVersion);
        await response.text();
      }
    );

    it("refuses an unsupported API version with 406 and no version headers", async () => {
      // 999, not 1. Paperless-ngx 2.16.0 still serves API versions 1 through 9
      // and only refuses 10 and above, while 3.1.3 serves 9 and 10 and refuses
      // 1 — so there is no *low* version that is unsupported everywhere in the
      // range this project claims to support. A version far above anything
      // upstream will plausibly reach is the only value that reliably produces
      // the refusal this test is about.
      const response = await rawRequest(
        "/documents/?page_size=1",
        {},
        "application/json; version=999"
      );

      expect(isApiVersionRejection(response.status)).toBe(true);

      // Measured, not assumed. Paperless fails content negotiation before the
      // middleware that stamps X-Api-Version/X-Version runs, so the one
      // response where the client would most like to know the server's API
      // version is the one response that does not carry it — even though this
      // request is fully authenticated. buildApiVersionError therefore always
      // takes its "no header" branch in practice, and this pins that.
      expect(readServerApiVersion(response.headers)).toBeNull();
      expect(readServerVersion(response.headers)).toBeNull();

      const error = buildApiVersionError(response.headers);
      expect(error.message).toContain(
        `refused API version ${REQUESTED_API_VERSION}`
      );
      expect(error.message).toContain("The upstream response body was not read");

      // Whatever the instance said in the body must not leak into our error.
      const upstreamBody = await response.text();
      expect(upstreamBody.length).toBeGreaterThan(0);
      expect(error.message).not.toContain(upstreamBody);
    });
  });

  describe("read-only workflow", () => {
    it("lists documents with pagination metadata", async () => {
      const page: any = await api.getDocuments("?page=1&page_size=2");
      expect(page).toHaveProperty("count");
      expect(page).toHaveProperty("next");
      expect(page).toHaveProperty("previous");
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

    it("pages through real data without repeating or dropping rows", async () => {
      // Five fixtures, so page_size=2 produces a genuine multi-page walk
      // rather than a single page that would prove nothing.
      const names = [1, 2, 3, 4, 5].map((n) => fixtureName(`page-${n}`));
      const pageFixtureIds: number[] = [];
      for (const name of names) {
        const tag: any = await api.createTag({ name, color: "#a6cee3" });
        createdTags.push(tag.id);
        pageFixtureIds.push(tag.id);
      }

      // A sixth tag the filter must *exclude*. Without it this test passes on a
      // fresh instance even if `name__istartswith` is silently ignored — the
      // five fixtures would be the only tags there, so "everything" and "the
      // five" are the same answer. Paperless ignores filter parameters it does
      // not recognise rather than rejecting them (an unknown `name__bogus=`
      // returns the full list), which is the same trap as `?q=` in the search
      // test, and it deserves the same guard.
      const decoy: any = await api.createTag({
        name: fixtureName("decoy"),
        color: "#a6cee3",
      });
      createdTags.push(decoy.id);

      const filter = `&name__istartswith=${encodeURIComponent(
        fixtureName("page-")
      )}&ordering=id`;

      const first: any = await api.getTags(`?page=1&page_size=2${filter}`);
      expect(
        first.count,
        "the name__istartswith filter returned the decoy too, so it was ignored and this test would prove nothing about pagination"
      ).toBe(5);
      expect(first.previous).toBeNull();
      expect(first.next).not.toBeNull();
      expect(first.results).toHaveLength(2);

      const second: any = await api.getTags(`?page=2&page_size=2${filter}`);
      expect(second.previous).not.toBeNull();
      expect(second.results).toHaveLength(2);

      const third: any = await api.getTags(`?page=3&page_size=2${filter}`);
      expect(third.next).toBeNull();
      expect(third.results).toHaveLength(1);

      const walked = [...first.results, ...second.results, ...third.results].map(
        (tag: any) => tag.id
      );
      // No row seen twice, none missed, and `ordering=id` respected across the
      // page boundary — the three ways real pagination goes wrong.
      expect(new Set(walked).size).toBe(5);
      expect(walked).toEqual([...pageFixtureIds].sort((a, b) => a - b));
      expect(walked).not.toContain(decoy.id);
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

    it("deletes the tag with a real 204 and stops listing it", async () => {
      // PaperlessAPI.request special-cases 204 by returning null instead of
      // parsing an empty body as JSON. That special case is only correct if
      // Paperless really answers 204 with no body, which is checked here at
      // the wire before the client-level behaviour is checked above it.
      const probeTag: any = await api.createTag({
        name: fixtureName("tag-204"),
        color: "#a6cee3",
      });
      // Registered before it is deleted, not after: if the assertions below
      // fail, the fixture still has to be cleaned up by the afterAll hook.
      createdTags.push(probeTag.id);

      const raw = await rawRequest(`/tags/${probeTag.id}/`, {
        method: "DELETE",
      });
      expect(raw.status).toBe(204);
      expect(await raw.text()).toBe("");
      createdTags.splice(createdTags.indexOf(probeTag.id), 1);

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

      await api.bulkEditObjects([correspondent.id], "correspondents", "delete");
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

  describe("bulk edit endpoints", () => {
    it.each(advertisedBulkEditMethods)(
      "still recognises bulk_edit method %s",
      async (method) => {
        // An empty document list mutates nothing, so this probes the method
        // vocabulary without touching data. Paperless then rejects on the
        // *parameters* (or accepts the no-op) — what it must never say is that
        // the method itself is not a valid choice, because that is what a
        // removed method looks like and our tool would be offering a lie.
        const response = await rawRequest("/documents/bulk_edit/", {
          method: "POST",
          body: JSON.stringify({ documents: [], method, parameters: {} }),
        });
        const body = await response.text();

        expect(
          body,
          `Paperless no longer accepts bulk_edit method "${method}". The bulk_edit_documents tool still offers it; remove it or move it to its own endpoint.`
        ).not.toContain("is not a valid choice");

        // The endpoint itself must still be there. The status beyond that is
        // deliberately not pinned: Paperless-ngx 2.16.0 answers 500 to
        // `set_permissions` with no parameters (an unhandled exception
        // upstream, reproducible with curl and unrelated to this client),
        // and asserting a status here would turn that into a red build for
        // someone else's defect. The claim under test is the method
        // vocabulary, and that is what is asserted.
        expect([404, 405]).not.toContain(response.status);
      }
    );

    it("rejects a method it does not know, so the check above can fail", async () => {
      // Guards the assertion itself: if Paperless stopped reporting unknown
      // methods this way, every test above would pass vacuously.
      const response = await rawRequest("/documents/bulk_edit/", {
        method: "POST",
        body: JSON.stringify({
          documents: [],
          method: "definitely_not_a_bulk_edit_method",
          parameters: {},
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("is not a valid choice");
    });
  });

  // Uploading needs a running consumer on the instance, so it is gated
  // separately: set PAPERLESS_TEST_UPLOAD=1 to include it. The CI lane sets it;
  // a developer pointing this suite at their own Paperless does not, and so
  // never has a document consumed into their library.
  describe.skipIf(!uploadEnabled)("synthetic document workflow", () => {
    const searchableTitle = fixtureName("document-searchable");
    const otherTitle = fixtureName("document-other");
    let searchableId: number;
    let otherId: number;

    const upload = async (title: string, body: string) => {
      const file = new File([new Blob([body])], `${title}.txt`, {
        type: "text/plain",
      });
      await api.postDocument(file, { title });

      const id = await poll(`${title} to be consumed`, 120_000, async () => {
        const page: any = await api.getDocuments(
          `?title__iexact=${encodeURIComponent(title)}`
        );
        return page.results?.[0]?.id;
      });
      createdDocuments.push(id);
      return id;
    };

    it(
      "uploads two documents and makes them retrievable",
      async () => {
        // Two, not one: a search that returns "everything" is indistinguishable
        // from a search that works when there is only one document to return.
        [searchableId, otherId] = await Promise.all([
          upload(
            searchableTitle,
            `Synthetic fixture for ${runId}. Safe to delete. ${searchNonce}\n`
          ),
          upload(
            otherTitle,
            `Synthetic fixture for ${runId}. Safe to delete. No marker here.\n`
          ),
        ]);

        const document: any = await api.getDocument(searchableId);
        expect(document.id).toBe(searchableId);
        expect(document.title).toBe(searchableTitle);
        expect(document.content).toContain(searchNonce);
      },
      180_000
    );

    it(
      "finds an uploaded document by full-text search, and only that document",
      async () => {
        // The headline of this whole lane. `searchDocuments` puts the term in
        // a `query=` parameter; Paperless ignores parameters it does not know
        // and answers with an unfiltered page, so a wrong name here returns
        // confident, plausible, wrong results. The assertion that catches that
        // is not "we got results" but "we got fewer results than everything,
        // and they are the right ones".
        const total: any = await api.getDocuments("?page_size=1");
        expect(total.count).toBeGreaterThanOrEqual(2);

        // Two different failures hide behind "no hit yet", and they need
        // telling apart: the index may not have caught up (wait), or the
        // parameter name may be wrong and Paperless silently returned
        // everything (waiting will never help). Check the second one first and
        // fail immediately, because a search that returns the whole library
        // cannot become correct by waiting — and sixty seconds spent reporting
        // "indexing timed out" would send whoever hits the exact bug this test
        // exists to catch off to look at the indexer.
        const firstLook: any = await api.searchDocuments(searchNonce, 1, 10);
        expect(
          firstLook.count,
          `Full-text search for a term in one document returned all ${total.count} documents on the instance. That is what Paperless does with a filter parameter it does not recognise, so searchDocuments is almost certainly sending the wrong parameter name — it must send 'query='.`
        ).not.toBe(total.count);

        let lastCount: number | undefined = firstLook.count;
        let hit: any;
        try {
          hit = await poll(
            `full-text search to index ${searchNonce}`,
            60_000,
            async () => {
              const result: any = await api.searchDocuments(
                searchNonce,
                1,
                10
              );
              lastCount = result.count;
              return result.count === 1 ? result : undefined;
            }
          );
        } catch {
          throw new Error(
            `Full-text search for ${searchNonce} never returned exactly 1 document within 60s; the last count was ${lastCount} and the instance holds ${total.count}. ` +
              (lastCount === 0
                ? "A count of 0 means the document was uploaded and consumed but never made it into the full-text index."
                : "A non-zero count that is not 1 means the search matched the wrong set — check the query parameter and the nonce.")
          );
        }

        expect(hit.count).toBe(1);
        expect(hit.count).toBeLessThan(total.count);
        expect(hit.results[0].id).toBe(searchableId);
        expect(hit.results.map((d: any) => d.id)).not.toContain(otherId);

        // ...and the client strips the payload it promises to strip.
        expect(hit.results[0]).not.toHaveProperty("content");
        expect(hit.results[0]).not.toHaveProperty("download_url");

        // The raw response proves this went through the full-text index rather
        // than some substring filter that happened to agree: only real search
        // hits carry __search_hit__.
        const raw = await rawRequest(
          `/documents/?query=${encodeURIComponent(searchNonce)}`
        );
        const payload: any = await raw.json();
        expect(payload.count).toBe(1);
        expect(payload.results[0]).toHaveProperty("__search_hit__");
        expect(payload.results[0].content).toContain(searchNonce);
      },
      120_000
    );

    it("updates a document and downloads it back", async () => {
      const updated: any = await api.updateDocument(searchableId, {
        title: `${searchableTitle}-renamed`,
      });
      expect(updated.title).toBe(`${searchableTitle}-renamed`);

      const download = await api.downloadDocument(searchableId, true);
      expect(download.ok).toBe(true);
      expect(await download.text()).toContain(searchNonce);
    });

    it("creates expiring archive and original public share links", async () => {
      const tool = publicShareTool(api);
      const cases = [
        { fileVersion: "archive", expirationDays: 1 },
        { fileVersion: "original", expirationDays: 7 },
      ] as const;

      for (const { fileVersion, expirationDays } of cases) {
        const before = Date.now();
        const result = await tool.handler(
          {
            id: searchableId,
            file_version: fileVersion,
            expiration_days: expirationDays,
          },
          {}
        );
        const payload = JSON.parse(result.content[0].text);
        createdShareLinks.push(payload.share_link_id);

        expect(payload.file_version).toBe(fileVersion);
        expect(payload.url).toMatch(
          new RegExp(`^${baseUrl}/share/[A-Za-z0-9]+$`)
        );
        const expiresAt = Date.parse(payload.expires_at);
        const duration = expirationDays * 24 * 60 * 60 * 1000;
        expect(expiresAt).toBeGreaterThanOrEqual(before + duration - 5_000);
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + duration + 5_000);

        const persistedResponse = await rawRequest(
          `/share_links/${payload.share_link_id}/`
        );
        expect(persistedResponse.status).toBe(200);
        const persisted: any = await persistedResponse.json();
        expect(persisted.file_version).toBe(fileVersion);
        expect(persisted.expiration).toBe(payload.expires_at);

        // The original-file case proves the returned bearer URL is usable
        // without an authenticated Paperless session. The synthetic text
        // fixture has no archive file on Paperless 2.16, so archive selection
        // is asserted against the persisted share-link record above.
        if (fileVersion === "original") {
          const publicResponse = await fetch(payload.url);
          expect(publicResponse.status).toBe(200);
          expect(await publicResponse.text()).toContain(searchNonce);
        }
      }
    });

    it("requires both add_sharelink and document visibility", async () => {
      const before = await activeShareLinkIds(searchableId);

      const viewerWithoutAdd = await createPrincipal("viewer-no-share", [
        "view_document",
      ]);
      await api.bulkEditDocuments(
        [searchableId],
        "set_permissions",
        buildBulkEditParameters("set_permissions", {
          permissions: {
            set_permissions: {
              view: { users: [viewerWithoutAdd.id], groups: [] },
              change: { users: [], groups: [] },
            },
            merge: true,
          },
        })
      );
      await expect(
        publicShareTool(viewerWithoutAdd.api).handler(
          { id: searchableId, expiration_days: 1 },
          {}
        )
      ).rejects.toThrow(/status: 403/);
      expect(await activeShareLinkIds(searchableId)).toEqual(before);

      const adderWithoutView = await createPrincipal("share-no-view", [
        "add_sharelink",
      ]);
      await expect(
        publicShareTool(adderWithoutView.api).handler(
          { id: searchableId, expiration_days: 1 },
          {}
        )
      ).rejects.toThrow(/status: (403|404)/);
      expect(await activeShareLinkIds(searchableId)).toEqual(before);
    });

    it("applies a bulk tag edit to a real document", async () => {
      const tag: any = await api.createTag({
        name: fixtureName("bulk-tag"),
        color: "#b2df8a",
      });
      createdTags.push(tag.id);

      const result: any = await api.bulkEditDocuments(
        [searchableId],
        "modify_tags",
        { add_tags: [tag.id], remove_tags: [] }
      );
      expect(result).toEqual({ result: "OK" });

      const document: any = await api.getDocument(searchableId);
      expect(document.tags).toContain(tag.id);
    });

    it("sets permissions on a real document, and they land", async () => {
      // The case the vocabulary probe could not see. Asserting that
      // `set_permissions` is a *recognised* method says nothing about whether
      // the payload around it is right, and it was not: the tool grouped
      // set_permissions/owner/merge under a `permissions` argument and sent it
      // nested, so Paperless never found `set_permissions` and the method had
      // never worked on any supported version. This sends what the tool now
      // builds and checks the result on the document.
      const usersResponse = await rawRequest("/users/?page_size=1");
      const users: any = await usersResponse.json();
      const userId = users.results[0].id;

      const parameters = buildBulkEditParameters("set_permissions", {
        permissions: {
          set_permissions: {
            view: { users: [userId], groups: [] },
            change: { users: [userId], groups: [] },
          },
          owner: userId,
          merge: false,
        },
      });
      // The flattening is the whole fix, so assert the shape before sending it.
      expect(parameters).toHaveProperty("set_permissions");
      expect(parameters).not.toHaveProperty("permissions");

      const result: any = await api.bulkEditDocuments(
        [searchableId],
        "set_permissions",
        parameters
      );
      expect(result).toEqual({ result: "OK" });

      const document: any = await api.getDocument(searchableId);
      expect(document.owner).toBe(userId);
    });

    it("rejects the nested shape the tool used to send, on this very instance", async () => {
      // Proof that the test above is load-bearing rather than decorative: the
      // payload this client sent until now is refused by the live server.
      // 3.1.3 answers 400 "set_permissions not specified"; 2.16.0 indexes the
      // missing key unguarded and answers 500. Either way the client throws,
      // which is exactly what users were getting.
      await expect(
        api.bulkEditDocuments([searchableId], "set_permissions", {
          permissions: {
            set_permissions: {
              view: { users: [], groups: [] },
              change: { users: [], groups: [] },
            },
          },
        })
      ).rejects.toThrow();
    });

    it("sends delete_pages a list, which is the only thing it accepts", async () => {
      // `pages` is documented by this tool as "1,3,5-7" and is correct in that
      // form for `split`, which Paperless expands itself. `delete_pages`
      // validates isinstance(pages, list) and rejects the string. An empty
      // document list keeps this from touching any data — the validation being
      // probed happens before anything is edited.
      const asString = await rawRequest("/documents/bulk_edit/", {
        method: "POST",
        body: JSON.stringify({
          documents: [],
          method: "delete_pages",
          parameters: { pages: "1,3" },
        }),
      });
      expect(await asString.text()).toContain("pages must be a list");

      const asList = await rawRequest("/documents/bulk_edit/", {
        method: "POST",
        body: JSON.stringify({
          documents: [],
          method: "delete_pages",
          parameters: buildBulkEditParameters("delete_pages", {
            pages: "1,3",
          }),
        }),
      });
      expect(
        await asList.text(),
        "the expanded page list was still rejected as the wrong type"
      ).not.toContain("pages must be a list");
    });

    it(
      "bulk-deletes the documents and they stop being retrievable",
      async () => {
        const ids = [searchableId, otherId];
        let lastStatus = 0;

        // The delete is re-issued on every attempt rather than issued once and
        // then waited on.
        //
        // The usual reason it could fail is gone: the stack now gives SQLite a
        // 30s busy timeout, so a request arriving mid-write waits instead of
        // being refused. This retry is what remains after that, and it is kept
        // deliberately, because the timeout fixes the *contention* and not the
        // thing that makes contention dangerous here — `bulk_edit.delete`
        // wraps the database delete and the index update in a single
        // try/except, logs "Error deleting documents: ..." and returns
        // `{"result":"OK"}` either way. A delete that fails for any reason at
        // all is therefore reported as success and leaves the document exactly
        // where it was, permanently: verified by holding a write lock during a
        // delete, where the document is still retrievable long after the lock
        // is gone.
        //
        // So "OK" cannot be trusted as evidence, no setting makes it
        // trustworthy, and re-asking is the only way to tell a slow delete
        // from one that silently did not happen. It costs nothing when the
        // first attempt works, and it cannot hide a real regression: a delete
        // that is permanently broken never yields a 404 and this still expires
        // red.
        await poll("the documents to be deleted", 30_000, async () => {
          // A repeat delete of already-deleted ids is rejected by validation,
          // which is fine — the GET below is what decides.
          await api.bulkEditDocuments(ids, "delete").catch(() => undefined);
          const response = await rawRequest(`/documents/${searchableId}/`);
          await response.text();
          lastStatus = response.status;
          return response.status === 404 ? true : undefined;
        }).catch(() => {
          throw new Error(
            `Documents ${ids.join(", ")} were still retrievable (HTTP ${lastStatus}) after repeated delete requests over 30s. ` +
              "Paperless answers this endpoint with OK even when the delete threw, so check the Paperless log for " +
              '"Error deleting documents" — a lost SQLite write lock is the known cause, and it is not something more waiting would fix.'
          );
        });

        for (const id of ids) {
          createdDocuments.splice(createdDocuments.indexOf(id), 1);
        }
      },
      60_000
    );
  });
});
