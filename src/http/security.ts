/**
 * DNS-rebinding protection for the `--http` transport.
 *
 * A browser page on any origin can POST to `http://localhost:3000/mcp`. Without
 * a Host/Origin check, a DNS-rebinding attack points an attacker-controlled
 * domain at 127.0.0.1 and drives this server — which holds a Paperless API
 * token — from the victim's browser.
 *
 * The MCP SDK 1.30 offers two mechanisms:
 *
 * - transport options `enableDnsRebindingProtection` / `allowedHosts` /
 *   `allowedOrigins` (marked `@deprecated` in that release: "use external
 *   middleware for DNS rebinding protection instead"), and
 * - `server/middleware/hostHeaderValidation`, the replacement it points at,
 *   which validates the Host header port-agnostically but has no Origin check.
 *
 * This module is the middleware path the SDK recommends, extended with the
 * Origin half and with redacted logging. Header values are attacker-controlled
 * free text, so a rejection logs only a reason code — never the value — and the
 * 403 body names the environment variable instead of echoing the input.
 *
 * Both checks run for every route, including the legacy SSE endpoints, which
 * the transport-level options could not have covered consistently.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { log } from "../logging";

/** Comma-separated hostnames (no ports) allowed in the Host header. */
export const ALLOWED_HOSTS_ENV = "PAPERLESS_MCP_ALLOWED_HOSTS";
/** Comma-separated origins allowed in the Origin header. */
export const ALLOWED_ORIGINS_ENV = "PAPERLESS_MCP_ALLOWED_ORIGINS";

/** Opt out of a check entirely by listing this value. */
export const ANY = "*";

/**
 * Safe default: loopback names only. Anything else — a container service name,
 * a reverse-proxy hostname — has to be opted into explicitly.
 */
export const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * `"any"` disables the check. A list restricts it; an **empty** origin list is
 * meaningful and is the default: requests carrying no Origin header at all
 * (every non-browser MCP client) pass, and any browser origin is rejected.
 */
export type Allowlist = readonly string[] | "any";

export interface HttpSecurityConfig {
  allowedHosts: Allowlist;
  allowedOrigins: Allowlist;
}

export type EnvLike = Record<string, string | undefined>;

function parseList(raw: string | undefined): string[] | "any" | undefined {
  if (raw === undefined) return undefined;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return undefined;
  if (entries.indexOf(ANY) !== -1) return "any";
  return entries.map((entry) => entry.toLowerCase());
}

/**
 * Resolve the Host/Origin allowlists from the environment. Unset — or set to an
 * empty/blank string — means "use the default".
 */
export function resolveHttpSecurity(env: EnvLike): HttpSecurityConfig {
  return {
    allowedHosts: parseList(env[ALLOWED_HOSTS_ENV]) ?? DEFAULT_ALLOWED_HOSTS,
    allowedOrigins: parseList(env[ALLOWED_ORIGINS_ENV]) ?? [],
  };
}

/** Human-readable rendering of an allowlist, for the startup log line. */
export function describeAllowlist(list: Allowlist): string {
  if (list === "any") return ANY;
  if (list.length === 0) return "(none)";
  return list.join(",");
}

/**
 * Extract the hostname from a Host header, dropping the port. Mirrors the URL
 * parsing the SDK's `hostHeaderValidation` uses, so `[::1]:3000` and
 * `localhost:3000` reduce to `[::1]` and `localhost`.
 */
export function hostnameOf(hostHeader: string): string | undefined {
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname;
    return hostname.length > 0 ? hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function reject(res: Response, reason: string, hint: string): void {
  log("warn", "http_request_rejected", { reason });
  res.status(403).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: `Forbidden: ${hint}` },
    id: null,
  });
}

/**
 * Express middleware enforcing {@link HttpSecurityConfig}. Rejects with 403 and
 * a JSON-RPC error body — the shape the SDK's own middleware uses.
 */
export function dnsRebindingProtection(
  config: HttpSecurityConfig
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { allowedHosts, allowedOrigins } = config;

    if (allowedHosts !== "any") {
      const hostHeader = req.headers.host;
      if (!hostHeader) {
        reject(res, "missing_host_header", "missing Host header");
        return;
      }
      const hostname = hostnameOf(hostHeader);
      if (hostname === undefined || allowedHosts.indexOf(hostname) === -1) {
        reject(
          res,
          "host_not_allowed",
          `Host not allowed. Set ${ALLOWED_HOSTS_ENV} to permit it.`
        );
        return;
      }
    }

    if (allowedOrigins !== "any") {
      const origin = req.headers.origin;
      // No Origin header at all: not a browser request, so rebinding does not
      // apply. Any present origin must be on the list.
      if (typeof origin === "string" && origin.length > 0) {
        if (allowedOrigins.indexOf(origin.toLowerCase()) === -1) {
          reject(
            res,
            "origin_not_allowed",
            `Origin not allowed. Set ${ALLOWED_ORIGINS_ENV} to permit it.`
          );
          return;
        }
      }
    }

    next();
  };
}

/**
 * The transport-level half of the protection, kept as defence in depth for the
 * Origin check. The transport's Host check compares the full `host:port` header
 * rather than the hostname, which the port-agnostic middleware above already
 * covers correctly, so only origins are handed down.
 */
export function transportSecurityOptions(config: HttpSecurityConfig): {
  enableDnsRebindingProtection?: boolean;
  allowedOrigins?: string[];
} {
  const { allowedOrigins } = config;
  if (allowedOrigins === "any" || allowedOrigins.length === 0) return {};
  return {
    enableDnsRebindingProtection: true,
    allowedOrigins: allowedOrigins.slice(),
  };
}
