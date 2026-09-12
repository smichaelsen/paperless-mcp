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
 * and `HEAD` *and* to requests with no body (issue #26). The exemption had two
 * ways around the parser: keyed on the path alone it let any `POST` through,
 * and scoping it to `GET`/`HEAD` alone still let a `GET` with
 * `Content-Type: application/json` through, because `express.json()` parses by
 * content type rather than by method. `isPublicRequest` below now refuses the
 * exemption to anything carrying a body, so the ordering this comment
 * describes holds for every request that skips authentication.
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
 * Does this request announce a message body?
 *
 * Exactly the two headers Node's HTTP parser itself uses to decide whether a
 * body follows, which is also what `express.json()` depends on: with neither
 * present the stream ends immediately and nothing can be read. So this covers
 * precisely the set of requests that could carry a parseable body — there is
 * no third framing an attacker could smuggle one through.
 *
 * Anything unparseable in `Content-Length` counts as a body. A malformed
 * length is not a reason to relax.
 */
export function announcesBody(headers: Request["headers"]): boolean {
  // Chunked: a body of unknown length, which is the worst case, not the best.
  if (headers["transfer-encoding"] !== undefined) return true;

  const raw = headers["content-length"];
  if (raw === undefined) return false;
  const value = (Array.isArray(raw) ? raw[0] : raw).trim();
  if (value.length === 0) return true;
  const length = Number(value);
  // `!== 0` rather than `> 0`: a negative Content-Length is malformed, not
  // empty, and must not read as "no body".
  return !Number.isInteger(length) || length !== 0;
}

/**
 * Does this request sit outside the authentication boundary?
 *
 * **All three** conditions have to hold — exempt method, exempt path, and no
 * body — because issue #26 turned out to have two doors:
 *
 * - Taking the *path* alone let a 9 MiB `POST /healthz` skip authentication
 *   and be buffered and parsed by `express.json()`.
 * - Adding the *method* closed that one but not the other: `express.json()`
 *   is mounted app-wide ahead of the health routes and parses by
 *   `Content-Type`, **not** by method. `GET` is the method the exemption has
 *   to allow, so `GET /healthz` with `Content-Type: application/json` and a
 *   9 MiB body was still parsed uncredentialed — measured at +381 MiB RSS for
 *   24 concurrent requests, and scaling linearly with the body limit.
 *
 * Hence the third condition. A liveness probe never sends a body, so losing
 * the exemption costs nothing real; a request that does send one is
 * authenticated like any other and is therefore rejected *before* the parser.
 *
 * ## Why losing the exemption, rather than a 400
 *
 * A body on a public path could have been its own error. It is not one,
 * because `GET /healthz` + body → 400 while `GET /anything-else` + body → 401
 * would re-open the route-existence oracle this same change closed. Falling
 * through to authentication makes the two answers byte-identical, and makes
 * the rule uniform: on *every* path, public or not, an unauthenticated
 * request carrying a body gets 401 and is never parsed.
 *
 * All three conditions live in one predicate rather than as extra checks at
 * the call site: one question, answered in one place, so a future exemption
 * cannot be added with only part of the policy applied — which is the failure
 * mode that produced both doors.
 */
export function isPublicRequest(req: Request): boolean {
  if (UNAUTHENTICATED_METHODS.indexOf(req.method) === -1) return false;
  // `req.path` has no query string, but a trailing slash is still possible.
  const path = req.path;
  const normalized =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (UNAUTHENTICATED_PATHS.indexOf(normalized) === -1) return false;
  return !announcesBody(req.headers);
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
    if (isPublicRequest(req)) {
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
