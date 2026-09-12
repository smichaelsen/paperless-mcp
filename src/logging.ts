/**
 * Structured, redacted operational logging.
 *
 * Every log line is a single JSON object written to **stderr** (stdout is the
 * MCP stdio channel and must stay clean). Only operational metadata is ever
 * emitted: HTTP method, a normalized endpoint class, HTTP status, duration and
 * an error class. Tokens, authorization headers, request bodies, uploaded file
 * data, document titles/content and raw Paperless response bodies are never
 * logged.
 */

export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<
  string,
  string | number | boolean | undefined | null
>;

/** Placeholder substituted for anything that looks like a credential. */
export const REDACTED = "[redacted]";

/**
 * Known secret values (the Paperless token). Registered secrets are scrubbed
 * from every string we log, so even an error message that embedded the token
 * cannot leak it.
 */
const knownSecrets = new Set<string>();

/** Register a secret value so it is scrubbed from all future log output. */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  // Very short values would scrub harmless substrings out of every message.
  if (trimmed.length < 6) return;
  knownSecrets.add(trimmed);
}

/** Test helper: forget all registered secrets. */
export function clearRegisteredSecrets(): void {
  knownSecrets.clear();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CREDENTIAL_QUERY_PARAMS =
  /([?&](?:token|api[_-]?key|apikey|key|password|passwd|secret|auth|access[_-]?token)=)[^&\s"']*/gi;
const AUTH_SCHEME = /\b(Token|Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;

/**
 * Scrub credential-shaped substrings (and any registered secret) from a string.
 * Applied to every string field before it is written to the log.
 */
export function redact(value: string): string {
  let out = value;
  // Longest first, so a secret that contains another is replaced whole.
  for (const secret of [...knownSecrets].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  out = out.replace(AUTH_SCHEME, `$1 ${REDACTED}`);
  out = out.replace(CREDENTIAL_QUERY_PARAMS, `$1${REDACTED}`);
  return out;
}

const SAFE_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Reduce a request path to an endpoint *class*: the query string is dropped and
 * every segment that is not a plain identifier (numeric ids, UUIDs, slugs —
 * anything that could carry user data) becomes `:id`.
 *
 * `/documents/4711/?query=tax%20return` -> `/documents/:id/`
 */
export function normalizeEndpoint(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0];
  const segments = withoutQuery
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => (SAFE_SEGMENT.test(segment) ? segment : ":id"));
  if (segments.length === 0) return "/";
  const joined = `/${segments.join("/")}`;
  return withoutQuery.endsWith("/") ? `${joined}/` : joined;
}

/** A coarse, safe classification of a thrown value. Never includes a message. */
export function errorClass(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name || "Error";
    const cause = (error as { cause?: unknown }).cause;
    // Node's fetch surfaces the interesting part as `cause.code`.
    if (cause && typeof (cause as { code?: unknown }).code === "string") {
      return `${name}:${(cause as { code: string }).code}`;
    }
    if (cause instanceof Error && cause.name && cause.name !== name) {
      return `${name}:${cause.name}`;
    }
    return name;
  }
  return typeof error;
}

/** Where log lines go. Indirection keeps tests able to capture output. */
function write(line: string): void {
  console.error(line);
}

/** Emit one structured log record. All string values are redacted. */
export function log(
  level: LogLevel,
  event: string,
  fields: LogFields = {}
): void {
  const record: Record<string, string | number | boolean> = {
    level,
    event: redact(event),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    record[key] = typeof value === "string" ? redact(value) : value;
  }
  write(JSON.stringify(record));
}

export interface RequestLogFields {
  method: string;
  endpoint: string;
  status?: number;
  durationMs: number;
  errorClass: string;
}

/** Log a failed Paperless request. Body and response are deliberately absent. */
export function logRequestFailure(fields: RequestLogFields): void {
  log("error", "paperless_request_failed", {
    method: fields.method,
    endpoint: fields.endpoint,
    status: fields.status,
    duration_ms: fields.durationMs,
    error_class: fields.errorClass,
  });
}

/**
 * Terminal error handler. Logs the error class and a redacted, truncated
 * message — never a raw error object, a stack, or a URL with embedded
 * credentials.
 */
export function logFatal(error: unknown): void {
  const rawMessage = error instanceof Error ? error.message : String(error);
  log("error", "startup_failed", {
    error_class: errorClass(error),
    message: redact(rawMessage).slice(0, 200),
  });
}
