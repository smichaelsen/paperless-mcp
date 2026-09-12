/**
 * The bearer-authentication middleware for the `--http` transport.
 *
 * ## One answer for every failure
 *
 * Missing header, `Basic` instead of `Bearer`, `Bearer` with nothing after it,
 * and a syntactically perfect but wrong secret all produce the *same* 401 with
 * the *same* body. Anything else is an oracle: a prober that can tell
 * "malformed" from "wrong" learns that its transport framing is right and can
 * concentrate on the secret.
 *
 * A *duplicated* `Authorization` header is not among these: Node keeps the
 * first and discards the rest, so the first copy is what gets authenticated.
 * See `bearerCredential`.
 *
 * The body names no variable either — unlike the Host/Origin rejection, which
 * points at `PAPERLESS_MCP_ALLOWED_HOSTS`, because a Host allowlist is
 * configuration and a bearer secret is a secret.
 *
 * ## Ordering
 *
 * Mounted *after* the Host/Origin check and the rate limiter and *before*
 * `express.json()`:
 *
 * - after Host/Origin, so a rebinding attempt is refused on the cheapest
 *   possible grounds and a browser page cannot even reach the auth path;
 * - after the rate limiter, so the secret cannot be brute-forced at line rate;
 * - before the body parser, so an unauthenticated caller can never make this
 *   process buffer and parse a multi-megabyte body.
 *
 * That last guarantee is the reason the health exemption is scoped to `GET`
 * and `HEAD` (issue #26). While it was keyed on the path alone, a `POST` to an
 * exempt path skipped this middleware and reached `express.json()` — the one
 * hole in an ordering the rest of this comment describes as airtight.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  bearerCredential,
  HttpAuthConfig,
  secretsMatch,
  UNAUTHENTICATED_METHODS,
  UNAUTHENTICATED_PATHS,
} from "../config/httpAuth";
import { log } from "../logging";

/**
 * The one and only rejection. `WWW-Authenticate` is required on a 401
 * (RFC 9110 §11.6.1) and carries no `realm` or `error` parameter, so it cannot
 * become the oracle the single body is there to avoid.
 */
function unauthorized(res: Response): void {
  // No reason code beyond "unauthenticated": which half of the credential was
  // wrong is exactly the thing not to write down, even into a local log.
  log("warn", "http_request_rejected", { reason: "unauthenticated" });
  res.setHeader("WWW-Authenticate", "Bearer");
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized" },
    id: null,
  });
}

/**
 * Does this request sit outside the authentication boundary?
 *
 * **Both** halves have to match: an exempt path on a non-exempt method is not
 * exempt. Taking the path alone was issue #26 — a 9 MiB `POST /healthz`
 * skipped authentication and was buffered and parsed by `express.json()`,
 * which is mounted after this middleware for exactly the opposite reason.
 *
 * The method is deliberately part of the same predicate rather than a second
 * check at the call site: one question, answered in one place, so a future
 * exemption cannot be added with only half the policy applied.
 */
export function isPublicRequest(method: string, path: string): boolean {
  if (UNAUTHENTICATED_METHODS.indexOf(method) === -1) return false;
  // `req.path` has no query string, but a trailing slash is still possible.
  const normalized =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return UNAUTHENTICATED_PATHS.indexOf(normalized) !== -1;
}

/**
 * Express middleware requiring `Authorization: Bearer <secret>`.
 *
 * With `{ mode: "disabled" }` it is a pass-through — the decision to allow
 * that is made once at startup in `src/config/httpAuth.ts`, not per request.
 */
export function bearerAuth(config: HttpAuthConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (config.mode === "disabled") {
      next();
      return;
    }
    if (isPublicRequest(req.method, req.path)) {
      next();
      return;
    }

    // A malformed header becomes the empty string rather than an early
    // return, so malformed and wrong take the same path through the same
    // constant-time compare and are indistinguishable by latency too. The
    // empty string can never match: `resolveHttpAuth` only ever yields a
    // non-empty secret, and the guard below makes that explicit.
    const credential = bearerCredential(req.headers.authorization) ?? "";
    if (
      config.secret.length === 0 ||
      !secretsMatch(credential, config.secret)
    ) {
      unauthorized(res);
      return;
    }

    next();
  };
}
