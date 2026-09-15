import { registerSecret } from "../logging";
import type { EnvLike } from "./credentials";

/** Public, browser-reachable Paperless base URL used only for clickable links. */
export const BROWSER_URL_ENV = "PAPERLESS_BROWSER_URL";

/** Raised when the configured browser-facing URL is unsafe or unusable. */
export class BrowserUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUrlError";
  }
}

function invalidBrowserUrl(reason: string): BrowserUrlError {
  // Name the setting and the violated rule, but never echo its value: malformed
  // URLs are exactly where embedded credentials are most likely to appear.
  return new BrowserUrlError(`${BROWSER_URL_ENV} ${reason}.`);
}

/**
 * Resolve the optional browser-facing Paperless URL.
 *
 * This setting is deliberately independent of `PAPERLESS_URL`: an absent value
 * stays absent, so an internal container or loopback address can never escape
 * through a generated link. Query strings and fragments are refused because
 * they can contain credentials and have no place in a deployment base URL.
 */
export function resolvePaperlessBrowserUrl(env: EnvLike): URL | undefined {
  const raw = env[BROWSER_URL_ENV]?.trim();
  if (!raw) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidBrowserUrl("must be an absolute HTTP(S) URL");
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.host) {
    throw invalidBrowserUrl("must be an absolute HTTP(S) URL");
  }
  if (url.username || url.password) {
    throw invalidBrowserUrl("must not contain embedded credentials");
  }
  if (url.search || url.hash) {
    throw invalidBrowserUrl("must not contain a query string or fragment");
  }

  // Deployment URLs are not credentials, but treating the configured value as
  // sensitive prevents an unrelated future error from logging it verbatim.
  registerSecret(raw);
  registerSecret(url.toString());
  return url;
}

/** Build the browser-session download endpoint while preserving a sub-path. */
export function documentDownloadUrl(
  browserUrl: URL,
  id: number,
  original = false
): string {
  const url = new URL(browserUrl.toString());
  const deploymentPath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${deploymentPath}/api/documents/${id}/download/`;
  url.search = original ? "original=true" : "";
  return url.toString();
}
