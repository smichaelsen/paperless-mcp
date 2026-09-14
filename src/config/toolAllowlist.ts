import type { EnvLike } from "./toolAccess";

/** Exact MCP tool names this process may register. */
export const ENABLED_TOOLS_ENV = "PAPERLESS_MCP_ENABLED_TOOLS";
/** Bulk-edit method names this process may advertise and accept. */
export const BULK_EDIT_METHODS_ENV = "PAPERLESS_MCP_BULK_EDIT_METHODS";
/** CLI equivalent of {@link ENABLED_TOOLS_ENV}. */
export const ENABLED_TOOLS_FLAG = "--enabled-tools";
/** CLI equivalent of {@link BULK_EDIT_METHODS_ENV}. */
export const BULK_EDIT_METHODS_FLAG = "--bulk-edit-methods";

/** Flags whose following argument must not be mistaken for a positional value. */
export const TOOL_ALLOWLIST_VALUE_FLAGS = new Set([
  ENABLED_TOOLS_FLAG,
  BULK_EDIT_METHODS_FLAG,
]);

export interface ConfiguredToolAllowlists {
  /** `undefined` means no allowlist was configured; `[]` is explicitly empty. */
  enabledTools: readonly string[] | undefined;
  /** `undefined` means no allowlist was configured; `[]` is explicitly empty. */
  bulkEditMethods: readonly string[] | undefined;
}

const NAME = /^[a-z][a-z0-9_]*$/;

function flagValue(flag: string, argv: readonly string[]): string | undefined {
  const matches: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === flag) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a comma-separated value.`);
      }
      matches.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith(`${flag}=`)) {
      matches.push(argument.slice(flag.length + 1));
    }
  }

  if (matches.length > 1) {
    throw new Error(`${flag} may be specified only once.`);
  }
  return matches[0];
}

function parseNames(setting: string, raw: string): readonly string[] {
  if (raw.trim() === "") return [];

  const names = raw.split(",").map((entry) => entry.trim());
  const emptyAt = names.findIndex((name) => name === "");
  if (emptyAt !== -1) {
    throw new Error(
      `${setting} contains an empty entry at position ${emptyAt + 1}.`
    );
  }

  for (const name of names) {
    if (!NAME.test(name)) {
      throw new Error(
        `${setting} entries must be lowercase MCP names using letters, digits, and underscores.`
      );
    }
  }

  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(`${setting} contains duplicate entry '${name}'.`);
    }
    seen.add(name);
  }

  return names;
}

function resolveList(
  env: EnvLike,
  argv: readonly string[],
  envName: string,
  flag: string
): readonly string[] | undefined {
  const cliValue = flagValue(flag, argv);
  if (cliValue !== undefined) return parseNames(flag, cliValue);

  const envValue = env[envName];
  if (envValue === undefined) return undefined;
  return parseNames(envName, envValue);
}

/**
 * Parse both allowlists without deciding what the active access mode permits.
 * CLI values take precedence over their environment equivalents, matching the
 * server's existing positional-argument precedence.
 */
export function resolveConfiguredToolAllowlists(
  env: EnvLike = process.env,
  argv: readonly string[] = process.argv.slice(2)
): ConfiguredToolAllowlists {
  return {
    enabledTools: resolveList(
      env,
      argv,
      ENABLED_TOOLS_ENV,
      ENABLED_TOOLS_FLAG
    ),
    bulkEditMethods: resolveList(
      env,
      argv,
      BULK_EDIT_METHODS_ENV,
      BULK_EDIT_METHODS_FLAG
    ),
  };
}
