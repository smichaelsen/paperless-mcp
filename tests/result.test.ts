import { describe, expect, it } from "vitest";
import { toTextResult } from "../src/tools/result";

describe("toTextResult", () => {
  it("wraps data in an MCP text content block", () => {
    const result = toTextResult({ id: 1 });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 1 });
  });

  it("pretty-prints so large document payloads stay readable", () => {
    expect(toTextResult({ id: 1, title: "Synthetic" }).content[0].text).toBe(
      '{\n  "id": 1,\n  "title": "Synthetic"\n}'
    );
  });

  it("round-trips nested list responses", () => {
    const payload = {
      count: 2,
      next: null,
      results: [{ id: 1, tags: [1, 2] }, { id: 2, tags: [] }],
    };
    expect(JSON.parse(toTextResult(payload).content[0].text)).toEqual(payload);
  });

  it("handles the null a 204 No Content response produces", () => {
    expect(toTextResult(null).content[0].text).toBe("null");
  });

  it("handles scalars and arrays", () => {
    expect(toTextResult("task-uuid").content[0].text).toBe('"task-uuid"');
    expect(toTextResult(42).content[0].text).toBe("42");
    expect(toTextResult([1, 2]).content[0].text).toBe("[\n  1,\n  2\n]");
  });

  it("produces undefined text for undefined rather than throwing", () => {
    // JSON.stringify(undefined) is undefined; documented so a handler that
    // forgets to await cannot silently ship a malformed content block.
    expect(toTextResult(undefined).content[0].text).toBeUndefined();
  });
});
