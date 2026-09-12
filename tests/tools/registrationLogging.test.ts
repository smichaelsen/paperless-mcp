/**
 * Registration must stay silent.
 *
 * Under `--http` a fresh `McpServer` is built for every connection, so anything
 * logged from inside `registerAllTools` is emitted on every single request. The
 * access mode cannot change while the process runs, so that line belongs at
 * startup — `src/index.ts` logs it once — and registration itself must log
 * nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PaperlessAPI } from "../../src/api/PaperlessAPI";
import { toolAccessMode } from "../../src/config/toolAccess";
import { registerAllTools } from "../../src/mcp/registerTools";

const MODES = [
  ["read-only", toolAccessMode(false, false), 9],
  ["write", toolAccessMode(true, false), 16],
  ["destructive", toolAccessMode(true, true), 20],
] as const;

function build(mode: ReturnType<typeof toolAccessMode>): string[] {
  const server = new McpServer({ name: "paperless-ngx", version: "1.0.0" });
  const api = new PaperlessAPI("https://paperless.example", "s3cr3t-token");
  return registerAllTools(server, api, mode);
}

describe("registerAllTools logging", () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  it.each(MODES)(
    "writes nothing to the log while registering the %s surface",
    (_label, mode) => {
      build(mode);
      expect(stderr).not.toHaveBeenCalled();
    }
  );

  it("stays silent across repeated registrations, as --http does per request", () => {
    const mode = toolAccessMode(false, false);
    for (let i = 0; i < 5; i += 1) build(mode);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("never reads the environment, so its warnings cannot repeat per request", () => {
    // `mode` is a required parameter precisely so registration cannot call
    // `resolveToolAccess()` itself. Resolution emits warnings for malformed
    // settings; doing it here would put those on every HTTP request, which is
    // the same defect as logging the mode here.
    const previous = process.env.PAPERLESS_ALLOW_WRITES;
    process.env.PAPERLESS_ALLOW_WRITES = "ture";
    try {
      for (let i = 0; i < 3; i += 1) build(toolAccessMode(false, false));
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.PAPERLESS_ALLOW_WRITES;
      else process.env.PAPERLESS_ALLOW_WRITES = previous;
    }
  });

  it.each(MODES)(
    "returns the %s surface so the caller can log the count once",
    (_label, mode, expected) => {
      const registered = build(mode);
      expect(registered).toHaveLength(expected);
      expect(new Set(registered).size).toBe(expected);
    }
  );
});
