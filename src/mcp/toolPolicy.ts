/**
 * The access class and MCP annotations of every tool this server can register.
 *
 * This table is the single place where "what does this tool do to Paperless?"
 * is decided. `registerAllTools` consults it for two things:
 *
 * 1. whether the tool may be registered under the active mode and exact-name
 *    allowlist, and
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
import type { ConfiguredToolAllowlists } from "../config/toolAllowlist";
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

/** The complete, already validated policy used by every registration. */
export interface EffectiveToolPolicy {
  mode: ToolAccessMode;
  enabledTools: readonly string[];
  bulkEditMethods: readonly string[];
}

/**
 * A gate may rewrite a registration for the active mode, or return `null` to
 * keep the tool out of `tools/list` entirely.
 */
export type ToolGate = (
  registration: ToolRegistration,
  policy: EffectiveToolPolicy
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
 *
 * `pages` is deliberately *not* here. It reads like a `delete_pages` argument,
 * but Paperless also takes it as the required split specification
 * (`BulkEditSerializer._validate_parameters_split` rejects a `split` without
 * it), so stripping it would advertise a `split` that can only ever answer 400.
 * Keeping it cannot widen the boundary: `delete_pages` is unreachable through
 * the narrowed enum and refused again by the handler, and `pages` alone does
 * nothing.
 */
export const BULK_EDIT_DESTRUCTIVE_ARGS = [
  "permissions",
  "delete_originals",
] as const;

/**
 * `pages` as write mode advertises it. The declared description documents the
 * `delete_pages` format, which is not the method it can serve here: for `split`
 * the value lists the page *ranges* that each become their own document.
 *
 * The last clause is not decoration. Paperless calls `method(documents,
 * **parameters)` and its bulk-edit functions take no `**kwargs`, so an argument
 * sent with a method that does not accept it raises a `TypeError` upstream and
 * comes back as an opaque 400 — it is not ignored. Telling a model otherwise
 * invites it to pass `pages` defensively and then fail undiagnosably.
 */
const WRITE_PAGES_DESCRIPTION =
  "Page specification for the 'split' method: comma-separated page ranges, each " +
  "of which becomes a new document. '1-2,3-4' splits a four-page document into " +
  "two. Required by 'split', and send it only with 'split': Paperless rejects " +
  "the whole request when an argument is passed to a method that does not take it.";

const WRITE_METHOD_DESCRIPTION =
  "The bulk operation to perform: set_correspondent (assign sender/receiver), " +
  "set_document_type (categorize documents), set_storage_path (organize file location), " +
  "add_tag/remove_tag/modify_tags (manage labels), reprocess (re-run OCR/indexing), " +
  "merge (combine documents into a new one, keeping the originals), " +
  "split (separate one document into several along the ranges given in 'pages', " +
  "keeping the original), " +
  "rotate (adjust orientation). Deleting documents or pages and replacing permissions " +
  "are not available: this server was not started with destructive operations enabled.";

function selectedMethodDescription(methods: readonly string[]): string {
  return (
    `The enabled bulk operations are: ${methods.join(", ")}. ` +
    "Any other bulk-edit method is disabled by the server policy."
  );
}

function sameNames(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((name) => right.includes(name))
  );
}

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
 * The mode and method allowlist therefore produce one narrowed contract. In
 * write mode, destructive methods and arguments are removed first. The method
 * enum is then reduced to the explicitly selected operations in either mode.
 * The handler re-checks both boundaries, so a client that ignores the schema is
 * refused rather than obeyed, and write-mode `merge`/`split` calls are forwarded
 * with an explicit `delete_originals: false` instead of relying on the Paperless
 * default.
 *
 * `pages` stays, redescribed: `split` cannot work without it. See
 * {@link BULK_EDIT_DESTRUCTIVE_ARGS}.
 */
export const gateBulkEditDocuments: ToolGate = (registration, policy) => {
  const { mode } = policy;
  if (!mode.writes) return null;
  const methods = policy.bulkEditMethods;
  if (methods.length === 0) return null;

  const allMethods = [
    ...BULK_EDIT_WRITE_METHODS,
    ...BULK_EDIT_DESTRUCTIVE_METHODS,
  ];
  if (mode.destructive && sameNames(methods, allMethods)) return registration;

  const rest: ToolShape = { ...registration.shape };
  delete rest.documents;
  delete rest.method;
  if (!mode.destructive) {
    for (const argument of BULK_EDIT_DESTRUCTIVE_ARGS) delete rest[argument];
    // Assigning an existing key keeps its position, so the argument order the
    // snapshot records does not shift.
    if (rest.pages) rest.pages = rest.pages.describe(WRITE_PAGES_DESCRIPTION);
  }

  const allWriteMethods = sameNames(methods, BULK_EDIT_WRITE_METHODS);

  return {
    ...registration,
    description:
      !mode.destructive && allWriteMethods
        ? "Perform bulk metadata operations on multiple documents simultaneously: " +
          "set correspondent/type/storage path, manage tags, reprocess, rotate, merge or split. " +
          "Deletion, page removal and permission changes are not available in this mode."
        : "Perform selected bulk operations on multiple documents simultaneously. " +
          `Enabled methods: ${methods.join(", ")}.`,
    shape: {
      documents: registration.shape.documents,
      method: z
        .enum(methods as unknown as [string, ...string[]])
        .describe(
          !mode.destructive && allWriteMethods
            ? WRITE_METHOD_DESCRIPTION
            : selectedMethodDescription(methods)
        ),
      ...rest,
    },
    handler: async (args: any, extra: any) => {
      if (isDestructiveMethod(args?.method)) {
        if (!mode.destructive) {
          throw new Error(
            `bulk_edit_documents method '${args.method}' is a destructive operation and is not enabled on this server.`
          );
        }
      }
      if (!methods.includes(String(args?.method))) {
        throw new Error(
          `bulk_edit_documents method '${String(args?.method)}' is not enabled on this server.`
        );
      }
      if (!mode.destructive && args?.delete_originals) {
        throw new Error(
          "bulk_edit_documents cannot delete the original documents: destructive operations are not enabled on this server."
        );
      }
      const safeArgs = { ...args };
      if (!mode.destructive) {
        for (const argument of BULK_EDIT_DESTRUCTIVE_ARGS) {
          delete safeArgs[argument];
        }
        if (safeArgs.method === "merge" || safeArgs.method === "split") {
          safeArgs.delete_originals = false;
        }
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

function rejectUnknownNames(
  names: readonly string[] | undefined,
  known: ReadonlySet<string>,
  setting: string
): void {
  if (!names) return;
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `${setting} contains unknown ${unknown.length === 1 ? "name" : "names"}: ${unknown.join(", ")}.`
    );
  }
}

/**
 * Intersect the configured allowlists with the coarse access mode. An
 * allowlist can remove capabilities, but it can never add a tool or method the
 * mode excludes.
 */
export function resolveEffectiveToolPolicy(
  mode: ToolAccessMode,
  configured: ConfiguredToolAllowlists
): EffectiveToolPolicy {
  const knownTools = new Set(Object.keys(TOOL_POLICIES));
  const allBulkMethods = [
    ...BULK_EDIT_WRITE_METHODS,
    ...BULK_EDIT_DESTRUCTIVE_METHODS,
  ];
  const knownBulkMethods = new Set<string>(allBulkMethods);

  rejectUnknownNames(
    configured.enabledTools,
    knownTools,
    "The tool allowlist"
  );
  rejectUnknownNames(
    configured.bulkEditMethods,
    knownBulkMethods,
    "The bulk-edit method allowlist"
  );

  if (mode.writes && configured.enabledTools === undefined) {
    throw new Error(
      "Write or destructive access requires an explicit PAPERLESS_MCP_ENABLED_TOOLS or --enabled-tools allowlist."
    );
  }

  const requestedTools =
    configured.enabledTools ?? Object.keys(TOOL_POLICIES);
  let enabledTools = requestedTools.filter((name) =>
    allows(mode, policyFor(name).access)
  );

  let bulkEditMethods: readonly string[] = [];
  if (enabledTools.includes("bulk_edit_documents")) {
    if (configured.bulkEditMethods === undefined) {
      throw new Error(
        "Enabling bulk_edit_documents requires an explicit PAPERLESS_MCP_BULK_EDIT_METHODS or --bulk-edit-methods allowlist."
      );
    }
    bulkEditMethods = configured.bulkEditMethods.filter(
      (method) =>
        mode.destructive ||
        (BULK_EDIT_WRITE_METHODS as readonly string[]).includes(method)
    );

    // A selected tool with no permitted operations has no truthful schema.
    // Keep it out of tools/list rather than inventing an empty zod enum.
    if (bulkEditMethods.length === 0) {
      enabledTools = enabledTools.filter(
        (name) => name !== "bulk_edit_documents"
      );
    }
  }

  return Object.freeze({
    mode,
    enabledTools: Object.freeze([...enabledTools].sort()),
    bulkEditMethods: Object.freeze([...bulkEditMethods]),
  });
}

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
 * Apply `effective` to a registration: return what should be advertised, or
 * `null` when the tool must stay absent from `tools/list`.
 */
export function gateRegistration(
  registration: ToolRegistration,
  effective: EffectiveToolPolicy
): ToolRegistration | null {
  if (!effective.enabledTools.includes(registration.name)) return null;

  const policy = policyFor(registration.name);
  if (policy.gate) return policy.gate(registration, effective);
  return allows(effective.mode, policy.access) ? registration : null;
}
