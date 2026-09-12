/**
 * Request-rate and body-size limits for the `--http` transport (issue #11).
 *
 * ## Why no dependency
 *
 * `express-rate-limit` would do this, but every production dependency has to
 * keep `npm audit --omit=dev --audit-level=high` clean forever, and what is
 * needed here is a counter and a clock. The implementation below is a fixed
 * window per client address — about forty lines, no transitive tree.
 *
 * ## Body size
 *
 * `express.json()`'s 100 kB default is not a security default here, it is a
 * bug: `post_document` carries the uploaded file **base64-encoded inside the
 * JSON-RPC body** (`src/tools/documents.ts`), so 100 kB caps every upload at
 * roughly 74 kB of actual file. The default below is 10 MB — about 7.5 MB of
 * file — and it is configurable in both directions. A read-only deployment,
 * which is the default access mode, never needs more than a few kilobytes and
 * can turn it right down.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { log } from "../logging";

/** Maximum accepted JSON body, as a byte count or an `express`/`bytes` size. */
export const MAX_BODY_ENV = "PAPERLESS_MCP_MAX_BODY";
/** Requests per window per client address. `0` disables rate limiting. */
export const RATE_LIMIT_MAX_ENV = "PAPERLESS_MCP_RATE_LIMIT_MAX";
/** Length of the rate-limit window in milliseconds. */
export const RATE_LIMIT_WINDOW_ENV = "PAPERLESS_MCP_RATE_LIMIT_WINDOW_MS";

export const DEFAULT_MAX_BODY = "10mb";
/**
 * Generous on purpose. One MCP tool call is one `POST /mcp` in stateless mode,
 * so an agent working through a document set legitimately makes bursts; this
 * is a brute-force and flood ceiling, not a quota.
 */
export const DEFAULT_RATE_LIMIT_MAX = 600;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Upper bound on tracked client addresses. Only reachable when a genuinely
 * large number of distinct sources connect (an IPv6 /64 has plenty); it caps
 * the limiter's own memory so it cannot become the DoS it prevents.
 */
const MAX_TRACKED_CLIENTS = 10_000;

export type EnvLike = Record<string, string | undefined>;

export interface HttpLimitsConfig {
  /** Passed straight to `express.json({ limit })`. */
  maxBody: string;
  rateLimitMax: number;
  rateLimitWindowMs: number;
}

/** `1024`, `10mb`, `512kb` — the grammar `express.json({ limit })` accepts. */
const SIZE = /^\d+(\.\d+)?\s*(b|kb|mb|gb)?$/i;

function parseSize(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (!SIZE.test(value)) {
    log("warn", "unrecognized_size_setting", {
      setting: MAX_BODY_ENV,
      expected: "a byte count or a size such as 10mb",
      using: DEFAULT_MAX_BODY,
    });
    return undefined;
  }
  return value;
}

function parseCount(
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number
): number {
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (value.length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    log("warn", "unrecognized_numeric_setting", {
      setting: name,
      expected: `an integer >= ${minimum}`,
      using: fallback,
    });
    return fallback;
  }
  return parsed;
}

/** Resolve both limits from the environment, falling back on the defaults. */
export function resolveHttpLimits(env: EnvLike): HttpLimitsConfig {
  return {
    maxBody: parseSize(env[MAX_BODY_ENV]) ?? DEFAULT_MAX_BODY,
    // 0 is a legitimate value: it disables rate limiting entirely.
    rateLimitMax: parseCount(
      RATE_LIMIT_MAX_ENV,
      env[RATE_LIMIT_MAX_ENV],
      DEFAULT_RATE_LIMIT_MAX,
      0
    ),
    rateLimitWindowMs: parseCount(
      RATE_LIMIT_WINDOW_ENV,
      env[RATE_LIMIT_WINDOW_ENV],
      DEFAULT_RATE_LIMIT_WINDOW_MS,
      1
    ),
  };
}

interface Window {
  count: number;
  /** Epoch ms at which this window ends and the count resets. */
  resetAt: number;
}

/**
 * Identify the client.
 *
 * `X-Forwarded-For` is deliberately **not** consulted: it is a plain request
 * header, so honouring it would let any caller pick its own bucket and opt out
 * of the limit entirely. Behind a reverse proxy every request therefore shares
 * the proxy's address and the limit is effectively global — still a useful
 * flood ceiling, and documented as such in the README.
 */
function clientKey(req: Request): string {
  return req.socket.remoteAddress ?? "unknown";
}

export interface RateLimiterOptions {
  max: number;
  windowMs: number;
  /** Injected by tests so a window can be advanced without waiting for one. */
  now?: () => number;
}

/**
 * Fixed-window rate limiting per client address. Answers 429 with
 * `Retry-After` and a JSON-RPC error body, the shape every other rejection on
 * this server uses.
 */
export function rateLimit(options: RateLimiterOptions): RequestHandler {
  const { max, windowMs } = options;
  const now = options.now ?? (() => Date.now());
  const windows = new Map<string, Window>();

  const prune = (at: number): void => {
    for (const [key, window] of windows) {
      if (window.resetAt <= at) windows.delete(key);
    }
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    if (max <= 0) {
      next();
      return;
    }

    const at = now();
    const key = clientKey(req);
    let window = windows.get(key);

    if (!window || window.resetAt <= at) {
      // Sweep on rollover rather than on a timer: no unref'd interval to keep
      // the process alive, and the work is proportional to what is stale.
      if (windows.size >= MAX_TRACKED_CLIENTS) prune(at);
      window = { count: 0, resetAt: at + windowMs };
      windows.set(key, window);
    }

    window.count += 1;

    if (window.count > max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((window.resetAt - at) / 1000)
      );
      // The client address is not logged: it is personal data and adds nothing
      // an operator's own access log does not already have.
      log("warn", "http_request_rejected", { reason: "rate_limited" });
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Too many requests" },
        id: null,
      });
      return;
    }

    next();
  };
}

/**
 * Turn `express.json()`'s "entity too large" into the JSON-RPC error shape the
 * rest of this server uses, instead of Express's default HTML error page.
 */
export function bodyLimitErrorHandler(): (
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction
) => void {
  return (error, _req, res, next) => {
    const type = (error as { type?: string } | undefined)?.type;
    if (type === "entity.too.large") {
      log("warn", "http_request_rejected", { reason: "body_too_large" });
      res.status(413).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Request body too large" },
        id: null,
      });
      return;
    }
    if (type === "entity.parse.failed") {
      log("warn", "http_request_rejected", { reason: "malformed_json" });
      // The offending body is never echoed back or logged.
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      });
      return;
    }
    next(error);
  };
}
