import { describe, expect, it } from "vitest";
import { toTextResult } from "../src/tools/result";

describe("toTextResult", () => {
  it("wraps data in an MCP text content block", () => {
    const result = toTextResult({ id: 1 });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 1 });
  });
});
