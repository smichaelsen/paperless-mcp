/**
 * Paperless-ngx REST API version negotiation.
 *
 * Paperless-ngx versions its REST API and clients pick a version with an
 * `Accept: application/json; version=N` header. If the instance does not
 * support the requested version it answers `406 Not Acceptable`.
 *
 * This module turns that 406 into an actionable error. It deliberately never
 * reads the upstream response body: the body can contain instance details we
 * do not want in an MCP tool result or in the log.
 *
 * See https://docs.paperless-ngx.com/api/ ("API Versioning").
 */

/** API version this client requests from Paperless-ngx. */
export const REQUESTED_API_VERSION = 9;

/** Oldest Paperless-ngx release that accepts API version 9. */
export const MIN_SUPPORTED_PAPERLESS_VERSION = "2.16.0";

/** Newest Paperless-ngx release verified to still accept API version 9. */
export const MAX_VERIFIED_PAPERLESS_VERSION = "3.1.3";

/** Minimal view of `Response.headers` — keeps this testable without a Response. */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Server-reported values are misconfiguration- or attacker-controlled strings.
 * Only a conservative shape is ever interpolated into an error message.
 */
const SAFE_SERVER_VERSION = /^[0-9A-Za-z.+_-]{1,32}$/;

export class PaperlessApiVersionError extends Error {
  readonly serverApiVersion: number | null;
  readonly serverVersion: string | null;

  constructor(
    message: string,
    serverApiVersion: number | null,
    serverVersion: string | null
  ) {
    super(message);
    this.name = "PaperlessApiVersionError";
    this.serverApiVersion = serverApiVersion;
    this.serverVersion = serverVersion;
  }
}

/** Paperless-ngx answers an unsupported `version=` with 406 Not Acceptable. */
export function isApiVersionRejection(status: number): boolean {
  return status === 406;
}

/** The `Accept` header this client sends on version-negotiated requests. */
export const ACCEPT_HEADER = `application/json; version=${REQUESTED_API_VERSION}`;

/**
 * Did this request negotiate an API version? Only then does a 406 mean the
 * version was refused — the upload and download paths send no version at all,
 * and a 406 from a proxy in front of them means something else entirely.
 */
export function requestsApiVersion(init: RequestInit): boolean {
  const headers = init.headers;
  if (!headers) return false;

  const accept =
    headers instanceof Headers
      ? headers.get("accept")
      : Array.isArray(headers)
      ? headers.find(([name]) => name.toLowerCase() === "accept")?.[1]
      : Object.entries(headers as Record<string, string>).find(
          ([name]) => name.toLowerCase() === "accept"
        )?.[1];

  return (
    typeof accept === "string" &&
    accept.replace(/\s+/g, "").includes(`version=${REQUESTED_API_VERSION}`)
  );
}

/**
 * Highest API version the instance offers, taken from the `X-Api-Version`
 * response header Paperless-ngx adds to authenticated responses. `null` when
 * the header is absent or not a plausible version number.
 */
export function readServerApiVersion(headers: HeaderReader): number | null {
  const raw = headers.get("x-api-version");
  if (!raw) return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 999) return null;
  return parsed;
}

/**
 * Paperless-ngx release string from the `X-Version` response header, or `null`
 * when absent or not a plain version-looking token.
 */
export function readServerVersion(headers: HeaderReader): string | null {
  const raw = headers.get("x-version");
  if (!raw) return null;
  const trimmed = raw.trim();
  return SAFE_SERVER_VERSION.test(trimmed) ? trimmed : null;
}

/**
 * Build the error thrown when Paperless-ngx refuses the requested API version.
 * Only the two version headers are used — never the response body.
 */
export function buildApiVersionError(
  headers: HeaderReader
): PaperlessApiVersionError {
  const serverApiVersion = readServerApiVersion(headers);
  const serverVersion = readServerVersion(headers);
  const instance = serverVersion
    ? `The instance (Paperless-ngx ${serverVersion})`
    : "The instance";

  const parts = [
    `Paperless-ngx refused API version ${REQUESTED_API_VERSION} (HTTP 406 Not Acceptable).`,
  ];

  if (serverApiVersion === null) {
    // This is the branch that fires in practice. Measured against live 2.16.0
    // and 3.1.3 instances (tests/integration): Paperless fails content
    // negotiation before the middleware that stamps X-Api-Version and
    // X-Version runs, so a 406 carries neither header no matter how the
    // request was authenticated. Saying "only sends that header on
    // authenticated requests" here — as this used to — sent people off to
    // check a token that was never the problem.
    parts.push(
      "The response carried no X-Api-Version header, so the API version of the instance could not be determined: Paperless-ngx refuses the version before it adds that header, so a refusal never carries it."
    );
    parts.push(
      `Check that the configured URL points at a Paperless-ngx instance of version ${MIN_SUPPORTED_PAPERLESS_VERSION} or newer — releases before that do not offer API version ${REQUESTED_API_VERSION}.`
    );
  } else if (serverApiVersion < REQUESTED_API_VERSION) {
    parts.push(
      `${instance} offers API version ${serverApiVersion} at most, but this client needs ${REQUESTED_API_VERSION}.`
    );
    parts.push(
      `Upgrade Paperless-ngx to ${MIN_SUPPORTED_PAPERLESS_VERSION} or newer.`
    );
  } else {
    parts.push(
      `${instance} has dropped API version ${REQUESTED_API_VERSION} and now offers version ${serverApiVersion}.`
    );
    parts.push(
      `Upgrade @smic/paperless-mcp to a release that requests API version ${serverApiVersion}, or run a Paperless-ngx release that still accepts version ${REQUESTED_API_VERSION} (verified up to ${MAX_VERIFIED_PAPERLESS_VERSION}).`
    );
  }

  parts.push("The upstream response body was not read and is not reported.");

  return new PaperlessApiVersionError(
    parts.join(" "),
    serverApiVersion,
    serverVersion
  );
}
