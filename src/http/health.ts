/**
 * Container and orchestrator probes: `GET /healthz` and `GET /readyz` (issue
 * #10).
 *
 * ## Two different questions
 *
 * - **`/healthz` — liveness.** Is this process still able to serve a request?
 *   It never touches Paperless. A restart is the only sensible reaction to a
 *   failure here, and restarting the MCP server because *Paperless* is down
 *   would turn one outage into a crash loop.
 * - **`/readyz` — readiness.** Is the upstream this server exists to proxy
 *   actually usable? A load balancer or a reverse proxy should stop sending
 *   traffic while the answer is no, but nothing should be restarted.
 *
 * Collapsing the two into one endpoint loses that distinction, which is why
 * the Dockerfile's `HEALTHCHECK` points at `/healthz` and the Compose example
 * documents `/readyz` as the endpoint for a proxy.
 *
 * ## These endpoints are unauthenticated, so they say almost nothing
 *
 * A Docker `HEALTHCHECK` or a Kubernetes probe cannot present a bearer token,
 * so `UNAUTHENTICATED_PATHS` in `src/config/httpAuth.ts` exempts both paths
 * from authentication — and only those two paths. They are still behind the
 * Host/Origin check and the rate limiter: those are app-wide middleware and
 * these routes are registered after them, which `tests/http/health.test.ts`
 * asserts by behaviour rather than by reading the middleware list.
 *
 * `bearerAuth` compares the path **case-sensitively**, while Express routes
 * case-insensitively, so `/HEALTHZ` would reach a handler here but is answered
 * `401` before it can. Rather than leave that to chance, the routes below match
 * case-sensitively too: a case variant is never served, in either layer.
 *
 * The price of being reachable without credentials is that the response is a
 * **static verdict and nothing else**: a fixed status code and a fixed
 * one-field body. No version, no Paperless URL, no configuration, no upstream
 * status code, no error text. An unauthenticated endpoint that reports what it
 * is attached to — or how its upstream failed — is a fingerprinting gift to
 * anyone probing the port.
 *
 * ## Why readiness is cached
 *
 * `/readyz` is unauthenticated, so without a cache it would be an amplifier:
 * one cheap request here would mean one authenticated request to Paperless,
 * and anyone who can reach the port could use this server to hammer Paperless
 * at whatever rate it can be reached. The verdict is therefore cached, and
 * concurrent requests share a single in-flight probe, so the upstream request
 * rate is bounded by the TTLs below no matter how fast the endpoint is called.
 *
 * Failures get a *shorter* TTL than successes: a recovering Paperless should
 * be noticed quickly, while a healthy one does not need re-proving every few
 * seconds. Both are bounded, so the amplification factor is bounded either
 * way.
 */
import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";

/** Liveness: the process is up. Never consults Paperless. */
export const HEALTH_PATH = "/healthz";
/** Readiness: Paperless is reachable and answering this server. */
export const READY_PATH = "/readyz";

/**
 * How long a *successful* readiness verdict is reused. Ten seconds keeps the
 * endpoint's upstream cost at most one request per ten seconds while still
 * reflecting an outage within one probe interval of a typical orchestrator.
 */
export const DEFAULT_READY_TTL_MS = 10_000;

/**
 * How long a *failed* verdict is reused. Deliberately shorter than the success
 * TTL: coming back into service quickly matters more than saving a request,
 * and it still caps the endpoint at one upstream request per two seconds.
 */
export const DEFAULT_NOT_READY_TTL_MS = 2_000;

/**
 * How long a single probe may take before it counts as unreachable. Without a
 * deadline a hung Paperless would leave `/readyz` hanging too, and a probe
 * that never settles would pin the single-flight slot forever.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * The upstream check. Resolving means "Paperless answered this server
 * successfully"; rejecting — for any reason at all — means it did not.
 *
 * It takes an `AbortSignal` rather than being raced against a timer so that a
 * timed-out probe actually releases its socket instead of continuing in the
 * background.
 *
 * The caller supplies this (see `src/index.ts`) precisely so this module never
 * learns the Paperless URL or token, and so nothing upstream-specific can leak
 * into a response by accident.
 */
export type UpstreamProbe = (signal: AbortSignal) => Promise<unknown>;

export interface HealthOptions {
  /**
   * Omitted means "no upstream check is wired up", and readiness then fails
   * closed: an unprobed server is not known to be ready, and reporting it
   * ready would make the endpoint worthless exactly when it matters.
   */
  probeUpstream?: UpstreamProbe;
  readyTtlMs?: number;
  notReadyTtlMs?: number;
  probeTimeoutMs?: number;
  /** Injected for tests. */
  now?: () => number;
}

interface CachedVerdict {
  ready: boolean;
  expiresAt: number;
}

/**
 * A cached, single-flight readiness check.
 *
 * Exported separately from the routes so the caching and coalescing behaviour
 * can be tested without going through HTTP.
 */
export function createReadinessGate(
  options: HealthOptions = {}
): () => Promise<boolean> {
  const {
    probeUpstream,
    readyTtlMs = DEFAULT_READY_TTL_MS,
    notReadyTtlMs = DEFAULT_NOT_READY_TTL_MS,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    now = () => Date.now(),
  } = options;

  if (!probeUpstream) return async () => false;

  let cached: CachedVerdict | undefined;
  let inFlight: Promise<boolean> | undefined;

  // Never rejects: every failure mode — transport error, HTTP status, refused
  // API version, timeout — is the same single bit of information, and a
  // rejecting promise stored in `inFlight` would become an unhandled rejection
  // for every waiter that has already been served from the cache.
  const runProbe = async (): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      await probeUpstream(controller.signal);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  return async function isReady(): Promise<boolean> {
    const at = now();
    if (cached && cached.expiresAt > at) return cached.ready;
    // Single flight: a burst of concurrent requests produces one upstream
    // call, not one each. Without this the cache would do nothing against a
    // burst, which is the shape an amplification attempt actually takes.
    if (inFlight) return inFlight;

    inFlight = runProbe()
      .then((ready) => {
        cached = {
          ready,
          expiresAt: now() + (ready ? readyTtlMs : notReadyTtlMs),
        };
        return ready;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

const OK_BODY = '{"status":"ok"}';
const UNAVAILABLE_BODY = '{"status":"unavailable"}';

/**
 * Write a verdict. One fixed body per outcome, and `no-store` so no proxy
 * between here and the prober can answer with a stale verdict.
 *
 * Deliberately `writeHead`/`end` rather than `res.json()`: `res.json()` routes
 * through `res.send()`, which attaches a weak `ETag` even to a `no-store`
 * response. A revalidating proxy then gets `304 Not Modified` on its second
 * probe — and `304` is not `response.ok`, so a perfectly healthy service reads
 * as unhealthy. There is nothing to revalidate here anyway: the body is one of
 * two constants.
 */
function verdict(res: Response, ok: boolean): void {
  const body = ok ? OK_BODY : UNAVAILABLE_BODY;
  res.writeHead(ok ? 200 : 503, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  // Node suppresses the body itself on a HEAD request, so this is correct for
  // both verbs `app.get` registers.
  res.end(body);
}

/**
 * Serve `handler` only for an exact, case-sensitive path match (a single
 * trailing slash allowed, matching how `isPublicPath` normalizes).
 *
 * Express matches `/HEALTHZ` against `app.get("/healthz")` by default, but
 * `bearerAuth`'s exemption list does not, so without this the two layers would
 * disagree about what a probe path even is. Anything that does not match
 * exactly falls through to the router's 404, which is the same answer any
 * unknown path gets — no oracle either way.
 */
function exactPath(path: string, handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requested = req.path;
    const normalized =
      requested.length > 1 && requested.endsWith("/")
        ? requested.slice(0, -1)
        : requested;
    if (normalized !== path) {
      next();
      return;
    }
    handler(req, res, next);
  };
}

/**
 * Register the probe routes. One call, so wiring them into the app is a single
 * line and rebasing that line is trivial.
 *
 * Must be registered *after* the app-wide middleware, which is what keeps these
 * routes inside the Host/Origin and rate-limit boundaries while the
 * authentication middleware skips them by path.
 */
export function registerHealthRoutes(
  app: Express,
  options: HealthOptions = {}
): void {
  const isReady = createReadinessGate(options);

  app.get(
    HEALTH_PATH,
    exactPath(HEALTH_PATH, (_req: Request, res: Response) => {
      // Reaching this handler *is* the liveness evidence: the process is up,
      // the event loop is turning and the router is intact. There is nothing
      // further to check that would not be a readiness question in disguise.
      verdict(res, true);
    })
  );

  app.get(
    READY_PATH,
    exactPath(READY_PATH, async (_req: Request, res: Response) => {
      // `isReady` never rejects, so there is no error path that could put an
      // upstream message into a response.
      verdict(res, await isReady());
    })
  );
}
