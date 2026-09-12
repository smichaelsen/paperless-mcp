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
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  bearerCredential,
  HttpAuthConfig,
  secretsMatch,
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

/** Does this path sit outside the authentication boundary? */
export function isPublicPath(path: string): boolean {
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
    if (isPublicPath(req.path)) {
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
