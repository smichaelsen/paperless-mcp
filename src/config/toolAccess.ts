/**
 * Which classes of Paperless operations this process may expose.
 *
 * Every tool belongs to exactly one access class (see `src/mcp/toolPolicy.ts`):
 *
 * - `read` — cannot change anything in Paperless;
 * - `write` — creates or updates objects, but never deletes one and never
 *   replaces a permission set;
 * - `destructive` — deletes documents, pages or objects, or replaces
 *   permissions: effects that cannot be undone from the MCP surface.
 *
 * The process starts **read-only**. Writes and destructive operations are two
 * independent opt-ins, and enabling writes does *not* enable destructive
 * operations. Whatever is not enabled is never registered, so it is absent from
 * `tools/list` rather than present-and-refusing: a model cannot be tempted by a
 * tool it cannot see, and a client's allowlist has less to cover.
 *
 * Configuration mirrors `src/config/credentials.ts`: environment first, with
 * the equivalent CLI flags for the `npx paperless-mcp …` invocation form.
 */
import { log } from "../logging";

/** Enables the `write` class. */
export const ALLOW_WRITES_ENV = "PAPERLESS_ALLOW_WRITES";
/** Enables the `destructive` class. Never implied by {@link ALLOW_WRITES_ENV}. */
export const ALLOW_DESTRUCTIVE_ENV = "PAPERLESS_ALLOW_DESTRUCTIVE";
/** CLI equivalent of {@link ALLOW_WRITES_ENV}. */
export const ALLOW_WRITES_FLAG = "--allow-writes";
/** CLI equivalent of {@link ALLOW_DESTRUCTIVE_ENV}. */
export const ALLOW_DESTRUCTIVE_FLAG = "--allow-destructive";

export type ToolAccess = "read" | "write" | "destructive";

/** Human-readable name of a mode — safe to log, used in errors and the README. */
export type ToolAccessLabel = "read-only" | "write" | "destructive";

export interface ToolAccessMode {
  /** Whether `write`-class tools are registered. */
  writes: boolean;
  /** Whether `destructive`-class tools are registered. */
  destructive: boolean;
  label: ToolAccessLabel;
}

export type EnvLike = Record<string, string | undefined>;

/** The default: nothing in Paperless can be changed through this server. */
export const READ_ONLY_MODE: ToolAccessMode = Object.freeze({
  writes: false,
  destructive: false,
  label: "read-only",
});

/** Build a mode from the two independent switches, normalizing the label. */
export function toolAccessMode(
  writes: boolean,
  destructive: boolean
): ToolAccessMode {
  // Every destructive operation is also a write, so `destructive` without
  // `writes` is a contradiction rather than a fourth mode; see resolveToolAccess.
  const effectiveWrites = writes || destructive;
  return {
    writes: effectiveWrites,
    destructive,
    label: destructive
      ? "destructive"
      : effectiveWrites
        ? "write"
        : "read-only",
  };
}

/** May a tool of this access class be registered in this mode? */
export function allows(mode: ToolAccessMode, access: ToolAccess): boolean {
  switch (access) {
    case "read":
      return true;
    case "write":
      return mode.writes;
    case "destructive":
      return mode.destructive;
  }
}

const TRUE_VALUES = new Set([
  "1",
  "true",
  "yes",
  "y",
  "on",
  "enable",
  "enabled",
]);
const FALSE_VALUES = new Set([
  "",
  "0",
  "false",
  "no",
  "n",
  "off",
  "disable",
  "disabled",
]);

/**
 * Parse a boolean switch. Anything unrecognized is a misconfiguration and is
 * treated as *off*: a typo must never silently widen what the server exposes.
 * The value itself is not logged — only the variable name.
 */
export function parseBooleanSetting(
  name: string,
  raw: string | undefined
): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  log("warn", "unrecognized_boolean_setting", {
    setting: name,
    expected: "true or false",
    using: "false",
  });
  return false;
}

/**
 * Resolve the access mode from the environment and the CLI arguments. A flag
 * or a truthy environment variable enables its class; the default is read-only.
 */
export function resolveToolAccess(
  env: EnvLike = process.env,
  argv: string[] = process.argv.slice(2)
): ToolAccessMode {
  const writes =
    argv.includes(ALLOW_WRITES_FLAG) ||
    parseBooleanSetting(ALLOW_WRITES_ENV, env[ALLOW_WRITES_ENV]);
  const destructive =
    argv.includes(ALLOW_DESTRUCTIVE_FLAG) ||
    parseBooleanSetting(ALLOW_DESTRUCTIVE_ENV, env[ALLOW_DESTRUCTIVE_ENV]);

  if (destructive && !writes) {
    // Enabling deletion but not ordinary updates is never what was meant, and
    // silently dropping the destructive tools would be just as surprising.
    log("warn", "destructive_implies_writes", {
      enabled: ALLOW_DESTRUCTIVE_ENV,
      also_enabling: ALLOW_WRITES_ENV,
    });
  }

  return toolAccessMode(writes, destructive);
}
