import { z } from "zod";

/**
 * Shared Zod shape for paginating list endpoints, mirroring the
 * `page` / `page_size` parameters already supported by search_documents.
 */
export const paginationParams = {
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based page number to retrieve. Paperless returns 25 results per page by default; use this together with the `next`/`count` fields in the response to enumerate all entries."),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(100000)
    .optional()
    .describe("Number of results per page. Increase this (e.g. 1000) to fetch all entries in a single call instead of paging."),
};

/**
 * Build the query string (including leading `?`, or empty) for a list
 * endpoint from optional pagination arguments.
 */
export function buildPaginationQuery(args: { page?: number; page_size?: number }) {
  const params = new URLSearchParams();
  if (args.page) params.set("page", args.page.toString());
  if (args.page_size) params.set("page_size", args.page_size.toString());
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
