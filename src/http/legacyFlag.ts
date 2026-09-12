/**
 * The switch for the deprecated HTTP+SSE routes.
 *
 * Separate from `legacySse.ts` so that reading the flag does not drag the SDK's
 * SSE transport into the module graph of anything that only wants to know
 * whether it is on.
 */
import { parseBooleanSetting } from "../config/toolAccess";

/** Opt in to `GET /sse` + `POST /messages`. Off by default. */
export const ENABLE_LEGACY_SSE_ENV = "PAPERLESS_MCP_ENABLE_LEGACY_SSE";

export type EnvLike = Record<string, string | undefined>;

/**
 * Are the legacy routes enabled? Default **off**: Streamable HTTP replaces
 * them, the SDK deprecates them, and an unrecognized value is treated as off
 * by `parseBooleanSetting` — a typo must not widen the surface.
 */
export function legacySseEnabled(env: EnvLike): boolean {
  return parseBooleanSetting(ENABLE_LEGACY_SSE_ENV, env[ENABLE_LEGACY_SSE_ENV]);
}
