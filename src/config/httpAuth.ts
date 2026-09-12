/**
 * Bearer authentication for the `--http` transport (issue #11).
 *
 * The HTTP listener hands out the complete Paperless tool surface to whoever
 * can reach it, so it must not be reachable without a shared secret.
 *
 * ## Where the secret comes from
 *
 * Exactly the shape `src/config/credentials.ts` established for the Paperless
 * token: `PAPERLESS_MCP_AUTH_TOKEN_FILE` (Docker/Kubernetes secrets, preferred)
 * takes precedence over the inline `PAPERLESS_MCP_AUTH_TOKEN`. There is
 * deliberately **no CLI flag**: an argument is visible in `ps`, in shell
 * history and in a container's `docker inspect` output.
 *
 * ## Fail closed
 *
 * `--http` with no secret and no explicit opt-out does not start. See
 * {@link resolveHttpAuth} for the reasoning; the opt-out is
 * `PAPERLESS_MCP_ALLOW_UNAUTHENTICATED`, it is loud, and `src/index.ts`
 * additionally refuses to combine it with a non-loopback bind address.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { log, registerSecret } from "../logging";
import { CredentialError, EnvLike, readSecretFile } from "./credentials";

/** Docker-secrets style: path to a file containing the bearer secret. */
export const AUTH_TOKEN_FILE_ENV = "PAPERLESS_MCP_AUTH_TOKEN_FILE";
/** Inline bearer secret. Lower precedence than {@link AUTH_TOKEN_FILE_ENV}. */
export const AUTH_TOKEN_ENV = "PAPERLESS_MCP_AUTH_TOKEN";
/** Explicit, documented opt-out from authentication. */
export const ALLOW_UNAUTHENTICATED_ENV = "PAPERLESS_MCP_ALLOW_UNAUTHENTICATED";

/**
 * Below this a secret is guessable at the rate limiter's ceiling. A warning,
 * not a hard failure: the length an operator chooses is their call, but a
 * four-character "secret" should never pass silently.
 */
export const MIN_RECOMMENDED_SECRET_LENGTH = 16;

export type HttpAuthConfig =
  | { mode: "bearer"; secret: string; source: string }
  | { mode: "disabled" };

/**
 * Routes that are deliberately outside the authentication boundary.
 *
 * Container and orchestrator probes cannot present a bearer token, so
 * `/healthz` and `/readyz` (issue #10) must answer without one. They are still
 * inside the Host/Origin and rate-limit boundaries, and whatever serves them
 * returns a static liveness/readiness verdict and nothing else — no version,
 * no Paperless URL, no configuration. See `src/http/health.ts`.
 *
 * An exemption is a **path and a method together** — see
 * {@link UNAUTHENTICATED_METHODS}. Both halves live here, in one place, so the
 * policy cannot be read as complete while half of it is somewhere else.
 */
export const UNAUTHENTICATED_PATHS: readonly string[] = ["/healthz", "/readyz"];

/**
 * The only methods exempt on {@link UNAUTHENTICATED_PATHS}.
 *
 * Issue #26: the exemption used to be keyed on the path alone, so it applied
 * to *every* method. `express.json()` is mounted after the auth middleware
 * precisely so an unauthenticated caller can never make this process buffer a
 * body — but a request to an exempt path skipped auth and reached the parser
 * anyway. Measured: 24 concurrent unauthenticated 9 MiB `POST /healthz` took
 * RSS from 73 MiB to 663 MiB. Against the documented `memory: 256M` container
 * limit with `restart: unless-stopped`, that is an OOM kill and a crash loop
 * for an attacker who holds no credential at all.
 *
 * A probe needs `GET`, and `HEAD` because Express answers it from the same
 * handler. Nothing else: every other method on these paths now falls through
 * to authentication and is rejected *before* the parser runs.
 *
 * The method is necessary but **not sufficient**. `express.json()` parses by
 * `Content-Type`, not by method, so a `GET` carrying a JSON body reached the
 * parser through this very exemption (+381 MiB RSS for 24 concurrent 9 MiB
 * requests, scaling with the body limit). An exempt request must also carry
 * no body — see `isPublicRequest` in `src/http/auth.ts`.
 *
 * This also closes a small oracle. `POST /healthz` used to return 404 while
 * `POST /nonexistent` returned 401, which told an unauthenticated prober
 * which routes exist. Both are 401 now.
 *
 * Compared case-sensitively against `req.method`, which HTTP defines as
 * case-sensitive (RFC 9110 §9.1). A lowercase `get` is not `GET` and is
 * authenticated like anything else.
 */
export const UNAUTHENTICATED_METHODS: readonly string[] = ["GET", "HEAD"];

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on", "enable", "enabled"]);

/**
 * Compare two secrets without leaking, through timing, how much of the
 * candidate was right.
 *
 * Both sides are hashed first, which buys two things a raw
 * `timingSafeEqual(Buffer.from(a), Buffer.from(b))` cannot:
 *
 * - `timingSafeEqual` **throws** on differing lengths, so a raw comparison
 *   would have to branch on length and thereby leak the secret's length;
 * - a non-ASCII or multi-byte candidate has a byte length unrelated to its
 *   character length, which the same branch would expose.
 *
 * SHA-256 digests are always 32 bytes, so the comparison itself is
 * unconditional and constant time for every input.
 */
export function secretsMatch(candidate: string, expected: string): boolean {
  const a = createHash("sha256").update(candidate, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Pull the credential out of an `Authorization` header.
 *
 * Returns `undefined` for every malformed case — absent, not `Bearer`, no
 * credential after the scheme. The caller must answer all of them identically
 * to a *wrong* secret; distinguishing them tells a prober which half of its
 * guess to fix.
 *
 * The scheme is matched case-insensitively (RFC 9110 §11.1: auth-scheme is
 * case-insensitive), the credential is not.
 *
 * ## Duplicate headers are *not* rejected here
 *
 * Node discards repeated `Authorization` headers and keeps the first, so
 * `req.headers.authorization` is a string whenever the header is present at
 * all (verified on v22.22.0: two headers, `[correct, wrong]`, authenticates
 * on the first and succeeds). Both copies survive in `req.rawHeaders`, but
 * nothing here looks at that, so **this server does not reject a duplicated
 * credential** — it authenticates against the first one. Not a weakness: an
 * attacker who can supply a correct value in either position already has the
 * secret.
 *
 * The non-string branch below is therefore defensive, unreachable over HTTP as
 * Node parses it today, and kept only against a future framework or transport
 * that does surface repeated headers as an array.
 */
export function bearerCredential(
  header: string | string[] | undefined
): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^[Bb][Ee][Aa][Rr][Ee][Rr] +(.+)$/.exec(header.trim());
  if (!match) return undefined;
  const credential = match[1].trim();
  return credential.length > 0 ? credential : undefined;
}

function parseBoolean(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Resolve the HTTP authentication configuration from the environment.
 *
 * Precedence: `PAPERLESS_MCP_AUTH_TOKEN_FILE` > `PAPERLESS_MCP_AUTH_TOKEN` >
 * the explicit `PAPERLESS_MCP_ALLOW_UNAUTHENTICATED` opt-out. With none of the
 * three set this **throws**, which is the deliberate choice:
 *
 * - the issue's acceptance criterion is that unauthenticated requests cannot
 *   initialize MCP or invoke a tool, and a default of "authentication is
 *   optional" does not meet it;
 * - the alternative — starting unauthenticated with a warning — is a warning
 *   in a log nobody reads on a server that hands out a Paperless token;
 * - the cost is one startup failure with an actionable message naming both the
 *   variable to set and the escape hatch, which an operator hits once.
 *
 * Throws a {@link CredentialError} when a `*_FILE` variable points at
 * something unreadable. The secret is registered with the log redactor and is
 * never logged.
 */
export function resolveHttpAuth(env: EnvLike): HttpAuthConfig {
  const filePath = env[AUTH_TOKEN_FILE_ENV]?.trim();
  const inline = env[AUTH_TOKEN_ENV]?.trim();

  let resolved: { value: string; source: string } | undefined;

  if (filePath) {
    if (inline) {
      log("warn", "http_auth_source_conflict", {
        using: AUTH_TOKEN_FILE_ENV,
        ignoring: AUTH_TOKEN_ENV,
      });
    }
    resolved = {
      value: readSecretFile(filePath, AUTH_TOKEN_FILE_ENV),
      source: AUTH_TOKEN_FILE_ENV,
    };
  } else if (inline) {
    resolved = { value: inline, source: AUTH_TOKEN_ENV };
  }

  if (resolved) {
    registerSecret(resolved.value);
    if (resolved.value.length < MIN_RECOMMENDED_SECRET_LENGTH) {
      // The length is metadata about the operator's choice, not the secret.
      log("warn", "http_auth_secret_short", {
        source: resolved.source,
        minimum_recommended: MIN_RECOMMENDED_SECRET_LENGTH,
      });
    }
    return { mode: "bearer", secret: resolved.value, source: resolved.source };
  }

  if (parseBoolean(env[ALLOW_UNAUTHENTICATED_ENV])) {
    log("warn", "http_auth_disabled", {
      via: ALLOW_UNAUTHENTICATED_ENV,
      consequence: "anyone who can reach the port can use every enabled tool",
    });
    return { mode: "disabled" };
  }

  // Deliberately free of the words "Bearer <value>": `redact()` treats that
  // shape as a credential and would replace half of its own error message.
  // It also has to survive logFatal's 200-character cap intact.
  throw new CredentialError(
    `--http requires an authentication secret. Set ${AUTH_TOKEN_FILE_ENV} ` +
      `(preferred) or ${AUTH_TOKEN_ENV}, or set ` +
      `${ALLOW_UNAUTHENTICATED_ENV}=true to run without one.`
  );
}

/** Human-readable auth state for the startup log line. Never the secret. */
export function describeAuth(auth: HttpAuthConfig): string {
  return auth.mode === "bearer" ? `bearer (${auth.source})` : "disabled";
}
