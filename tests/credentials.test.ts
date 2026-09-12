import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CredentialError,
  LEGACY_TOKEN_ENV,
  readSecretFile,
  resolvePaperlessToken,
  TOKEN_ENV,
  TOKEN_FILE_ENV,
} from "../src/config/credentials";
import { clearRegisteredSecrets } from "../src/logging";

const SENTINEL_TOKEN = "sentinel-token-9f8e7d6c5b4a";

describe("Paperless credential loading", () => {
  let dir: string;
  let captured: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "paperless-mcp-creds-"));
    captured = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    clearRegisteredSecrets();
  });

  function secretFile(name: string, contents: string): string {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  }

  describe("readSecretFile", () => {
    it("reads the secret and strips the trailing newline", () => {
      const path = secretFile("token", `${SENTINEL_TOKEN}\n`);
      expect(readSecretFile(path, TOKEN_FILE_ENV)).toBe(SENTINEL_TOKEN);
    });

    it("strips a CRLF line ending too", () => {
      const path = secretFile("token-crlf", `${SENTINEL_TOKEN}\r\n`);
      expect(readSecretFile(path, TOKEN_FILE_ENV)).toBe(SENTINEL_TOKEN);
    });

    it("fails clearly when the file does not exist", () => {
      const path = join(dir, "missing");
      expect(() => readSecretFile(path, TOKEN_FILE_ENV)).toThrow(
        CredentialError
      );
      expect(() => readSecretFile(path, TOKEN_FILE_ENV)).toThrow(/ENOENT/);
      expect(() => readSecretFile(path, TOKEN_FILE_ENV)).toThrow(
        new RegExp(TOKEN_FILE_ENV)
      );
    });

    it("fails clearly when the path is not a readable file", () => {
      // A directory is unreadable as a file regardless of the running uid,
      // which keeps this test honest when the suite runs as root in CI.
      expect(() => readSecretFile(dir, TOKEN_FILE_ENV)).toThrow(
        CredentialError
      );
    });

    it("fails clearly when the file is empty", () => {
      const path = secretFile("empty", "\n");
      expect(() => readSecretFile(path, TOKEN_FILE_ENV)).toThrow(/is empty/);
    });
  });

  describe("resolvePaperlessToken", () => {
    it("returns undefined when nothing is configured", () => {
      expect(resolvePaperlessToken({})).toBeUndefined();
    });

    it("reads PAPERLESS_API_TOKEN", () => {
      expect(resolvePaperlessToken({ [TOKEN_ENV]: SENTINEL_TOKEN })).toEqual({
        value: SENTINEL_TOKEN,
        source: TOKEN_ENV,
      });
      expect(captured).toEqual([]);
    });

    it("reads PAPERLESS_API_TOKEN_FILE", () => {
      const path = secretFile("token", `${SENTINEL_TOKEN}\n`);
      expect(resolvePaperlessToken({ [TOKEN_FILE_ENV]: path })).toEqual({
        value: SENTINEL_TOKEN,
        source: TOKEN_FILE_ENV,
      });
    });

    it("prefers the file form and says so when both are set", () => {
      const path = secretFile("token", SENTINEL_TOKEN);
      const resolved = resolvePaperlessToken({
        [TOKEN_FILE_ENV]: path,
        [TOKEN_ENV]: "ignored-inline-token",
      });
      expect(resolved?.source).toBe(TOKEN_FILE_ENV);
      expect(resolved?.value).toBe(SENTINEL_TOKEN);
      expect(captured.join("\n")).toContain("credential_source_conflict");
    });

    it("propagates an unreadable file as a clear error", () => {
      expect(() =>
        resolvePaperlessToken({ [TOKEN_FILE_ENV]: join(dir, "missing") })
      ).toThrow(CredentialError);
    });

    it("still accepts the deprecated API_KEY and warns about it", () => {
      const resolved = resolvePaperlessToken({
        [LEGACY_TOKEN_ENV]: SENTINEL_TOKEN,
      });
      expect(resolved).toEqual({
        value: SENTINEL_TOKEN,
        source: LEGACY_TOKEN_ENV,
      });
      const record = JSON.parse(captured[0]);
      expect(record).toMatchObject({
        level: "warn",
        event: "deprecated_credential_env",
        variable: LEGACY_TOKEN_ENV,
      });
      expect(record.replacement).toContain(TOKEN_ENV);
    });

    it("never writes the credential value to the log", () => {
      const path = secretFile("token", SENTINEL_TOKEN);
      resolvePaperlessToken({
        [TOKEN_FILE_ENV]: path,
        [TOKEN_ENV]: SENTINEL_TOKEN,
        [LEGACY_TOKEN_ENV]: SENTINEL_TOKEN,
      });
      expect(captured.join("\n")).not.toContain(SENTINEL_TOKEN);
    });

    it("prefers the new variables over the deprecated one", () => {
      const resolved = resolvePaperlessToken({
        [TOKEN_ENV]: SENTINEL_TOKEN,
        [LEGACY_TOKEN_ENV]: "legacy-value",
      });
      expect(resolved?.source).toBe(TOKEN_ENV);
      expect(captured).toEqual([]);
    });

    it("ignores blank values", () => {
      expect(
        resolvePaperlessToken({ [TOKEN_ENV]: "   ", [LEGACY_TOKEN_ENV]: "" })
      ).toBeUndefined();
    });
  });
});
