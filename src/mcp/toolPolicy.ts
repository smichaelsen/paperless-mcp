/**
 * The access class and MCP annotations of every tool this server can register.
 *
 * This table is the single place where "what does this tool do to Paperless?"
 * is decided. `registerAllTools` consults it for two things:
 *
 * 1. whether the tool may be registered at all in the active mode
 *    (`src/config/toolAccess.ts`), and
 * 2. the `annotations` advertised for it in `tools/list`.
 *
 * A tool that is not listed here cannot be registered: registration throws
 * rather than guessing, so adding a tool module without classifying it fails
 * the test suite instead of quietly appearing in read-only mode.
 *
 * ## Annotation semantics (MCP spec, mirrored in
 * `@modelcontextprotocol/sdk/types.js`)
 *
 * - `readOnlyHint` — true iff the tool does not modify its environment.
 * - `destructiveHint` — true if the tool *may* perform destructive updates,
 *   false if its updates are purely additive. Meaningful only when
 *   `readOnlyHint` is false; it is stated everywhere anyway, and for read-only
 *   tools the stated value is the one the spec defines them to have.
 * - `idempotentHint` — true if repeating the call with the same arguments has
 *   no additional effect.
 * - `openWorldHint` — false throughout: every tool talks to exactly one
 *   configured Paperless instance, a closed domain.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolAccess, ToolAccessMode } from "../config/toolAccess";
import { allows } from "../config/toolAccess";

type AnyZodType = z.ZodType<any, any, any>;

/** A tool's declared arguments: field name -> zod schema. */
export type ToolShape = Record<string, AnyZodType>;

/** A tool as the tool modules declare it, before any gating is applied. */
export interface ToolRegistration {
  name: string;
  description: string;
  shape: ToolShape;
  handler: (args: any, extra: any) => Promise<any>;
}

/**
 * A gate may rewrite a registration for the active mode, or return `null` to
 * keep the tool out of `tools/list` entirely.
 */
export type ToolGate = (
  registration: ToolRegistration,
  mode: ToolAccessMode
) => ToolRegistration | null;

export interface ToolPolicy {
  access: ToolAccess;
  annotations: ToolAnnotations;
  /** Only for tools whose destructiveness depends on an argument. */
  gate?: ToolGate;
}

/** Reads Paperless and changes nothing. */
const READS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Creates a new object; a repeat creates a second one or is rejected. */
const CREATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * Overwrites or removes existing state, but converges: repeating the call with
 * the same arguments leaves Paperless in the same place (a second `delete_tag`
 * for the same id removes nothing further).
 */
const REPLACES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Overwrites or removes existing state and does *not* converge: `rotate`
 * rotates again, `merge`/`split` produce another document every time.
 */
const MUTATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * `bulk_edit_documents` methods that only create or update metadata.
 *
 * `merge` and `split` are here because on their own they leave the source
 * documents in place; they become destructive only through `delete_originals`,
 * which the gate below removes from the advertised schema and refuses at
 * runtime unless destructive operations are enabled.
 */
export const BULK_EDIT_WRITE_METHODS = [
  "set_correspondent",
  "set_document_type",
  "set_storage_path",
  "add_tag",
  "remove_tag",
  "modify_tags",
  "reprocess",
  "merge",
  "split",
  "rotate",
] as const;

/** `bulk_edit_documents` methods that delete content or replace permissions. */
export const BULK_EDIT_DESTRUCTIVE_METHODS = [
  "delete",
  "set_permissions",
  "delete_pages",
] as const;

/**
 * Arguments that only ever serve a destructive method, or turn a
 * non-destructive one destructive. Removed from the write-mode schema.
 */
export const BULK_EDIT_DESTRUCTIVE_ARGS = [
  "permissions",
  "delete_originals",
  "pages",
] as const;

const WRITE_METHOD_DESCRIPTION =
  "The bulk operation to perform: set_correspondent (assign sender/receiver), " +
  "set_document_type (categorize documents), set_storage_path (organize file location), " +
  "add_tag/remove_tag/modify_tags (manage labels), reprocess (re-run OCR/indexing), " +
  "merge (combine documents into a new one, keeping the originals), " +
  "split (separate into multiple documents, keeping the original), " +
  "rotate (adjust orientation). Deleting documents or pages and replacing permissions " +
  "are not available: this server was not started with destructive operations enabled.";

function isDestructiveMethod(method: unknown): boolean {
  return (BULK_EDIT_DESTRUCTIVE_METHODS as readonly string[]).includes(
    String(method)
  );
}

/**
 * `bulk_edit_documents` is one tool whose destructiveness depends on its
 * `method` argument: the same endpoint sets a correspondent and permanently
 * deletes documents. Registering it wholesale in write mode would hand back
 * everything the destructive switch is supposed to hold back; refusing at call
 * time would leave a destructive tool advertised.
 *
 * So in write mode the tool is registered with a **narrowed** contract: the
 * `method` enum only offers the non-destructive methods, and the arguments that
 * exist solely to delete (`delete_originals`, `pages`) or to replace
 * permissions are dropped from the schema. The handler re-checks both, so a
 * client that ignores the schema is refused rather than obeyed, and
 * `merge`/`split` are forwarded with an explicit `delete_originals: false`
 * instead of relying on the Paperless default.
 */
export const gateBulkEditDocuments: ToolGate = (registration, mode) => {
  if (!mode.writes) return null;
  if (mode.destructive) return registration;

  const rest: ToolShape = { ...registration.shape };
  delete rest.documents;
  delete rest.method;
  for (const argument of BULK_EDIT_DESTRUCTIVE_ARGS) delete rest[argument];

  return {
    ...registration,
    description:
      "Perform bulk metadata operations on multiple documents simultaneously: " +
      "set correspondent/type/storage path, manage tags, reprocess, rotate, merge or split. " +
      "Deletion, page removal and permission changes are not available in this mode.",
    shape: {
      documents: registration.shape.documents,
      method: z
        .enum(BULK_EDIT_WRITE_METHODS as unknown as [string, ...string[]])
        .describe(WRITE_METHOD_DESCRIPTION),
      ...rest,
    },
    handler: async (args: any, extra: any) => {
      if (isDestructiveMethod(args?.method)) {
        throw new Error(
          `bulk_edit_documents method '${args.method}' is a destructive operation and is not enabled on this server.`
        );
      }
      if (args?.delete_originals) {
        throw new Error(
          "bulk_edit_documents cannot delete the original documents: destructive operations are not enabled on this server."
        );
      }
      const safeArgs = { ...args };
      for (const argument of BULK_EDIT_DESTRUCTIVE_ARGS) {
        delete safeArgs[argument];
      }
      if (safeArgs.method === "merge" || safeArgs.method === "split") {
        safeArgs.delete_originals = false;
      }
      return registration.handler(safeArgs, extra);
    },
  };
};

/**
 * Every tool, classified. Read the `access` value as the answer to "what is the
 * worst this tool can do to a Paperless instance?".
 */
export const TOOL_POLICIES: Record<string, ToolPolicy> = {
  // --- read ---------------------------------------------------------------
  get_document: { access: "read", annotations: READS },
  search_documents: { access: "read", annotations: READS },
  download_document: { access: "read", annotations: READS },
  list_tags: { access: "read", annotations: READS },
  get_tag: { access: "read", annotations: READS },
  list_correspondents: { access: "read", annotations: READS },
  get_correspondent: { access: "read", annotations: READS },
  list_document_types: { access: "read", annotations: READS },
  get_document_type: { access: "read", annotations: READS },

  // --- write --------------------------------------------------------------
  post_document: { access: "write", annotations: CREATES },
  create_tag: { access: "write", annotations: CREATES },
  create_correspondent: { access: "write", annotations: CREATES },
  create_document_type: { access: "write", annotations: CREATES },
  // Updates overwrite: `tags` replaces the whole tag list and the nullable
  // relations clear a field outright — destructive, but convergent.
  update_document: { access: "write", annotations: REPLACES },
  update_tag: { access: "write", annotations: REPLACES },
  // Write-classified only because the gate above strips its destructive half.
  bulk_edit_documents: {
    access: "write",
    annotations: MUTATES,
    gate: gateBulkEditDocuments,
  },

  // --- destructive --------------------------------------------------------
  delete_tag: { access: "destructive", annotations: REPLACES },
  // Both operations are destructive: `delete` removes the objects, and
  // `set_permissions` with `merge: false` replaces the permission set.
  bulk_edit_tags: { access: "destructive", annotations: REPLACES },
  bulk_edit_correspondents: { access: "destructive", annotations: REPLACES },
  bulk_edit_document_types: { access: "destructive", annotations: REPLACES },
};

/** Look up a tool's policy, refusing to register anything unclassified. */
export function policyFor(name: string): ToolPolicy {
  const policy = TOOL_POLICIES[name];
  if (!policy) {
    throw new Error(
      `Tool "${name}" has no entry in TOOL_POLICIES: classify it as read, write or destructive before registering it.`
    );
  }
  return policy;
}

/**
 * Apply the policy for `registration` in `mode`: the registration to advertise,
 * or `null` when the tool must stay absent from `tools/list`.
 */
export function gateRegistration(
  registration: ToolRegistration,
  mode: ToolAccessMode
): ToolRegistration | null {
  const policy = policyFor(registration.name);
  if (policy.gate) return policy.gate(registration, mode);
  return allows(mode, policy.access) ? registration : null;
}
