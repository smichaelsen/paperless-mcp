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
 * Hard upper bound on tracked client addresses — a real cap, enforced on every
 * insert, not a sweep threshold.
 *
 * The key is the remote address, which an attacker with an IPv6 /64 controls
 * by the billion, so an unbounded map would let an unauthenticated caller turn
 * the rate limiter into the memory exhaustion it exists to prevent.
 *
 * ## What happens when it is full
 *
 * Expired windows are swept first. If that is not enough, the **oldest** entry
 * is evicted to make room for the new one. The alternatives are both worse:
 *
 * - *refuse the new entry and answer 429* — an attacker fills the map once and
 *   every genuinely new client is locked out. A real, remotely triggerable
 *   denial of service.
 * - *admit the new entry untracked* — an attacker fills the map and then rate
 *   limits nobody, including themselves.
 *
 * Evicting the oldest costs an attacker-controlled counter reset: whoever is
 * evicted starts a fresh window early. That is worth stating plainly, but it
 * grants nothing new — an attacker who can present {@link MAX_TRACKED_CLIENTS}
 * distinct source addresses can already evade a per-address limit simply by
 * cycling them, and eviction can only *reset* a victim's counter (giving them
 * more allowance), never lock them out.
 *
 * Insertion order is window-start order — a rollover deletes before
 * re-inserting — so the first key of the Map is the oldest window and
 * eviction is O(1).
 */
export const MAX_TRACKED_CLIENTS = 10_000;

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
  /** Overridable so a test can reach the cap without 10,000 requests. */
  maxTrackedClients?: number;
}

/**
 * The middleware, plus one introspection hook.
 *
 * `trackedClients()` exists so a test can assert the cap is a *cap* rather
 * than inferring it from behaviour. Nothing in `src/` calls it.
 */
export type RateLimitHandler = RequestHandler & {
  /** How many client addresses currently have a window. */
  trackedClients(): number;
};

/**
 * Fixed-window rate limiting per client address. Answers 429 with
 * `Retry-After` and a JSON-RPC error body, the shape every other rejection on
 * this server uses. Memory is bounded — see {@link MAX_TRACKED_CLIENTS}.
 */
export function rateLimit(options: RateLimiterOptions): RateLimitHandler {
  const { max, windowMs } = options;
  const now = options.now ?? (() => Date.now());
  const capacity = Math.max(1, options.maxTrackedClients ?? MAX_TRACKED_CLIENTS);
  const windows = new Map<string, Window>();

  const prune = (at: number): void => {
    for (const [key, window] of windows) {
      if (window.resetAt <= at) windows.delete(key);
    }
  };

  /** Drop expired windows, then the oldest, until there is room for one more. */
  const makeRoom = (at: number): void => {
    if (windows.size < capacity) return;
    prune(at);
    while (windows.size >= capacity) {
      const oldest = windows.keys().next();
      if (oldest.done) return;
      windows.delete(oldest.value);
    }
  };

  const handler = (req: Request, res: Response, next: NextFunction): void => {
    if (max <= 0) {
      next();
      return;
    }

    const at = now();
    const key = clientKey(req);
    let window = windows.get(key);

    if (!window || window.resetAt <= at) {
      makeRoom(at);
      window = { count: 0, resetAt: at + windowMs };
      // Delete first: `Map.set` on an existing key keeps its original
      // insertion position, which would make insertion order diverge from
      // window-start order and evict the wrong entry.
      windows.delete(key);
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

  return Object.assign(handler, { trackedClients: () => windows.size });
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
