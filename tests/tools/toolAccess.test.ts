import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALLOW_DESTRUCTIVE_ENV,
  ALLOW_DESTRUCTIVE_FLAG,
  ALLOW_WRITES_ENV,
  ALLOW_WRITES_FLAG,
  allows,
  parseBooleanSetting,
  resolveToolAccess,
  toolAccessMode,
} from "../../src/config/toolAccess";

let logged: string[];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveToolAccess", () => {
  it("is read-only when nothing is configured", () => {
    expect(resolveToolAccess({}, [])).toEqual({
      writes: false,
      destructive: false,
      label: "read-only",
    });
  });

  it("ignores an unrelated environment and the transport flags", () => {
    const mode = resolveToolAccess(
      { PAPERLESS_URL: "https://paperless.example", HOME: "/root" },
      ["--http", "--port", "3000"]
    );
    expect(mode.label).toBe("read-only");
  });

  it("enables writes, but not destructive operations, on the writes switch", () => {
    for (const mode of [
      resolveToolAccess({ [ALLOW_WRITES_ENV]: "true" }, []),
      resolveToolAccess({}, [ALLOW_WRITES_FLAG]),
    ]) {
      expect(mode).toEqual({
        writes: true,
        destructive: false,
        label: "write",
      });
    }
  });

  it("enables destructive operations only on their own switch", () => {
    for (const mode of [
      resolveToolAccess(
        { [ALLOW_WRITES_ENV]: "1", [ALLOW_DESTRUCTIVE_ENV]: "1" },
        []
      ),
      resolveToolAccess({}, [ALLOW_WRITES_FLAG, ALLOW_DESTRUCTIVE_FLAG]),
    ]) {
      expect(mode).toEqual({
        writes: true,
        destructive: true,
        label: "destructive",
      });
    }
  });

  it("treats a lone destructive switch as writes plus destructive, and says so", () => {
    const mode = resolveToolAccess({ [ALLOW_DESTRUCTIVE_ENV]: "yes" }, []);

    expect(mode).toEqual({
      writes: true,
      destructive: true,
      label: "destructive",
    });
    expect(logged.join("\n")).toContain("destructive_implies_writes");
  });

  it("accepts the usual spellings of a boolean", () => {
    for (const value of ["1", "true", "TRUE", " yes ", "on", "enabled"]) {
      expect(
        resolveToolAccess({ [ALLOW_WRITES_ENV]: value }, []).writes,
        value
      ).toBe(true);
    }
    for (const value of ["", "0", "false", "no", "off", " disabled "]) {
      expect(
        resolveToolAccess({ [ALLOW_WRITES_ENV]: value }, []).writes,
        value
      ).toBe(false);
    }
  });

  it("fails closed on an unrecognized value, and warns without echoing it", () => {
    const mode = resolveToolAccess(
      { [ALLOW_DESTRUCTIVE_ENV]: "sure-why-not" },
      []
    );

    expect(mode.destructive).toBe(false);
    expect(mode.label).toBe("read-only");
    const output = logged.join("\n");
    expect(output).toContain("unrecognized_boolean_setting");
    expect(output).toContain(ALLOW_DESTRUCTIVE_ENV);
    expect(output).not.toContain("sure-why-not");
  });

  it("does not accept a flag as a value, or a value as a flag", () => {
    expect(resolveToolAccess({}, ["--allow-writes=true"]).writes).toBe(false);
    expect(
      resolveToolAccess({ [ALLOW_WRITES_ENV]: "--allow-writes" }, []).writes
    ).toBe(false);
  });
});

describe("parseBooleanSetting", () => {
  it("is false when the variable is absent", () => {
    expect(parseBooleanSetting("X", undefined)).toBe(false);
    expect(logged).toEqual([]);
  });
});

describe("allows", () => {
  const readOnly = toolAccessMode(false, false);
  const write = toolAccessMode(true, false);
  const destructive = toolAccessMode(true, true);

  it("permits reads everywhere", () => {
    for (const mode of [readOnly, write, destructive]) {
      expect(allows(mode, "read")).toBe(true);
    }
  });

  it("permits writes only from write mode upwards", () => {
    expect(allows(readOnly, "write")).toBe(false);
    expect(allows(write, "write")).toBe(true);
    expect(allows(destructive, "write")).toBe(true);
  });

  it("permits destructive operations only in destructive mode", () => {
    expect(allows(readOnly, "destructive")).toBe(false);
    expect(allows(write, "destructive")).toBe(false);
    expect(allows(destructive, "destructive")).toBe(true);
  });
});
