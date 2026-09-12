/**
 * Where the `--http` listener binds.
 *
 * `app.listen(port)` binds `::`/`0.0.0.0` — every interface. That was
 * exploitable: from another host on the LAN, a request carrying a forged
 * `Host: localhost` passed the DNS-rebinding check (it only looks at the
 * header, which the attacker writes) and was answered with a full MCP
 * `initialize`. Host/Origin validation is a browser defence; it was never a
 * network one.
 *
 * So the default is loopback, and reaching the server from anywhere else is an
 * explicit opt-in via `PAPERLESS_MCP_BIND_ADDRESS`. It is an environment
 * variable and not a CLI flag on purpose: the stdio form takes positional
 * arguments, and adding another value-carrying flag to that parser is exactly
 * the kind of change that turns `paperless-mcp --host 0.0.0.0` into a base URL
 * of `0.0.0.0`.
 */
import { log } from "../logging";

/** Interface the `--http` listener binds to. Default: loopback only. */
export const BIND_ADDRESS_ENV = "PAPERLESS_MCP_BIND_ADDRESS";

/** IPv4 loopback. Chosen over `::1` because every client resolves it. */
export const DEFAULT_BIND_ADDRESS = "127.0.0.1";

export type EnvLike = Record<string, string | undefined>;

/**
 * Addresses that reach only this host. `localhost` is included as a
 * convenience — Node resolves it, and it is loopback on any sane system.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/** Everything a loopback-only address is not: the wildcard binds. */
export function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  if (LOOPBACK.has(normalized)) return true;
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/** Resolve the bind address, defaulting to loopback. */
export function resolveBindAddress(env: EnvLike): string {
  const configured = env[BIND_ADDRESS_ENV]?.trim();
  if (!configured) return DEFAULT_BIND_ADDRESS;
  if (!isLoopbackAddress(configured)) {
    // Not an error — it is a supported, documented deployment — but it must
    // never happen silently. The address is operator configuration, not user
    // data, so it is safe to name.
    log("warn", "http_bind_not_loopback", {
      address: configured,
      reminder: "terminate TLS at a trusted reverse proxy or tunnel",
    });
  }
  return configured;
}
