import { describe, expect, it } from "vitest";
import { buildPaginationQuery } from "../src/tools/pagination";

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
});
