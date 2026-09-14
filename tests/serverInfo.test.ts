/**
 * The version is written down twice — in `package.json`, and as a literal in
 * `src/index.ts` that is advertised to every MCP client as `serverInfo.version`.
 *
 * It cannot be read from `package.json` at runtime: importing a file from
 * outside `src/` pulls it into the TypeScript root and moves the compiled
 * entrypoint off `build/index.js`, breaking the `paperless-mcp` bin (see
 * CLAUDE.md). So the two copies are kept honest here instead, because a release
 * that bumps one and not the other ships a server whose self-reported version
 * is a lie, and nothing else in the suite would notice.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

describe("serverInfo", () => {
  it("advertises the version in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8")
    ) as { version: string };
    const source = readFileSync(join(ROOT, "src", "index.ts"), "utf8");

    const declared = source.match(/const SERVER_VERSION = "([^"]+)"/);
    expect(declared, "SERVER_VERSION not found in src/index.ts").not.toBeNull();
    expect(declared![1]).toBe(pkg.version);
  });

  it("leaves no other hard-coded version in the server construction", () => {
    const source = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
    expect(source).toContain("new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })");
  });
});
