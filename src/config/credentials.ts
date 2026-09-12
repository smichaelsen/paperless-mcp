import { readFileSync } from "node:fs";
import { log, registerSecret } from "../logging";

/** Preferred env var holding the Paperless API token. */
export const TOKEN_ENV = "PAPERLESS_API_TOKEN";
/** Docker-secrets style: path to a file containing the Paperless API token. */
export const TOKEN_FILE_ENV = "PAPERLESS_API_TOKEN_FILE";
/** Deprecated, generically named predecessor of {@link TOKEN_ENV}. */
export const LEGACY_TOKEN_ENV = "API_KEY";

export type EnvLike = Record<string, string | undefined>;

export interface ResolvedCredential {
  value: string;
  /** Name of the env var the value came from — safe to log. */
  source: string;
}

/** Raised when a credential is configured but cannot be loaded. */
export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

/**
 * Read a secret from a file (Docker secrets style). Surrounding whitespace —
 * in practice the trailing newline every editor and `echo` adds — is stripped.
 * Fails with a clear, value-free message if the file cannot be read or is empty.
 */
export function readSecretFile(filePath: string, envVarName: string): string {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code ?? "unknown error";
    throw new CredentialError(
      `Cannot read ${envVarName}: ${filePath} (${code})`
    );
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw new CredentialError(`${envVarName}: ${filePath} is empty`);
  }
  return value;
}

/**
 * Resolve the Paperless API token from the environment.
 *
 * Precedence: `PAPERLESS_API_TOKEN_FILE` > `PAPERLESS_API_TOKEN` > `API_KEY`
 * (deprecated). Returns `undefined` when none is configured; throws a
 * {@link CredentialError} when a `*_FILE` variable points at something
 * unreadable. The token value itself is never logged.
 */
export function resolvePaperlessToken(
  env: EnvLike
): ResolvedCredential | undefined {
  const filePath = env[TOKEN_FILE_ENV]?.trim();
  const inline = env[TOKEN_ENV]?.trim();
  const legacy = env[LEGACY_TOKEN_ENV]?.trim();

  if (filePath) {
    if (inline) {
      log("warn", "credential_source_conflict", {
        using: TOKEN_FILE_ENV,
        ignoring: TOKEN_ENV,
      });
    }
    const value = readSecretFile(filePath, TOKEN_FILE_ENV);
    registerSecret(value);
    return { value, source: TOKEN_FILE_ENV };
  }

  if (inline) {
    registerSecret(inline);
    return { value: inline, source: TOKEN_ENV };
  }

  if (legacy) {
    log("warn", "deprecated_credential_env", {
      variable: LEGACY_TOKEN_ENV,
      replacement: `${TOKEN_ENV} (or ${TOKEN_FILE_ENV})`,
    });
    registerSecret(legacy);
    return { value: legacy, source: LEGACY_TOKEN_ENV };
  }

  return undefined;
}
