import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildPaginationQuery, paginationParams } from "../src/tools/pagination";

const schema = z.object(paginationParams);

describe("buildPaginationQuery", () => {
  it("returns an empty string when no pagination is requested", () => {
    expect(buildPaginationQuery({})).toBe("");
  });

  it("serializes page and page_size", () => {
    expect(buildPaginationQuery({ page: 2, page_size: 50 })).toBe(
      "?page=2&page_size=50"
    );
  });

  it("omits absent parameters", () => {
    expect(buildPaginationQuery({ page: 3 })).toBe("?page=3");
    expect(buildPaginationQuery({ page_size: 1000 })).toBe("?page_size=1000");
  });

  it("keeps page before page_size so URLs are stable across calls", () => {
    expect(buildPaginationQuery({ page_size: 50, page: 2 })).toBe(
      "?page=2&page_size=50"
    );
  });

  it("ignores extra arguments handed in by a tool handler", () => {
    expect(
      buildPaginationQuery({ page: 1, extra: "ignored" } as any)
    ).toBe("?page=1");
  });

  it("treats out-of-range values rejected by the schema as absent", () => {
    // The zod shape rejects these before a handler is reached; the builder is
    // defensive about them rather than emitting `?page=0`.
    expect(buildPaginationQuery({ page: 0, page_size: 0 })).toBe("");
  });
});

describe("paginationParams schema", () => {
  it("makes both parameters optional", () => {
    expect(schema.safeParse({}).success).toBe(true);
  });

  it("requires positive integers", () => {
    expect(schema.safeParse({ page: 1, page_size: 25 }).success).toBe(true);
    expect(schema.safeParse({ page: 0 }).success).toBe(false);
    expect(schema.safeParse({ page: -1 }).success).toBe(false);
    expect(schema.safeParse({ page: 2.5 }).success).toBe(false);
    expect(schema.safeParse({ page_size: 0 }).success).toBe(false);
  });

  it("caps page_size at 100000", () => {
    expect(schema.safeParse({ page_size: 100000 }).success).toBe(true);
    expect(schema.safeParse({ page_size: 100001 }).success).toBe(false);
  });

  it("does not coerce strings, so clients get a clear validation error", () => {
    expect(schema.safeParse({ page: "2" }).success).toBe(false);
  });
});
