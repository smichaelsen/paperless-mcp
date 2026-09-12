# Paperless-NGX MCP Server

An MCP (Model Context Protocol) server for interacting with a Paperless-NGX API server. This server provides tools for managing documents, tags, correspondents, and document types in your Paperless-NGX instance.

## Supported versions

| | Supported |
| --- | --- |
| Paperless-ngx | **2.16.0 – 3.1.x** (verified against 3.1.3) |
| Paperless-ngx REST API | version **9** |
| Node.js | 22 LTS and 24 LTS |

The client asks Paperless-ngx for a specific REST API version with an
`Accept: application/json; version=9` header. API version 9 was introduced in
Paperless-ngx 2.16.0 and is still accepted by the current 3.1.x releases, which
allow versions 9 and 10. Older instances (≤ 2.15.x) do not know version 9.

If the instance does not accept the requested version it answers
`406 Not Acceptable`; the server turns that into an explicit error naming the
API version the instance offers (from its `X-Api-Version` header) and what to
upgrade. The upstream response body is never read, logged, or forwarded into a
tool result.

Paperless-ngx documents its versioning scheme and per-version changelog under
[REST API → API Versioning](https://docs.paperless-ngx.com/api/). Older API
versions are supported by Paperless-ngx for at least one year after a newer one
is released.

## Quick Start

### Installation
1. Install the MCP server:
```bash
npm install -g paperless-mcp
```

2. Add it to your Claude's MCP configuration:

For VSCode extension, edit `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`:
```json
{
  "mcpServers": {
    "paperless": {
      "command": "npx",
      "args": ["paperless-mcp", "http://your-paperless-instance:8000", "your-api-token"]
    }
  }
}
```

For Claude desktop app, edit `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "paperless": {
      "command": "npx",
      "args": ["paperless-mcp", "http://your-paperless-instance:8000", "your-api-token"]
    }
  }
}
```

3. Get your API token:
   1. Log into your Paperless-NGX instance
   2. Click your username in the top right
   3. Select "My Profile"
   4. Click the circular arrow button to generate a new token

4. Replace the placeholders in your MCP config:
   - `http://your-paperless-instance:8000` with your Paperless-NGX URL
   - `your-api-token` with the token you just generated

That's it! Now you can ask Claude to help you manage your Paperless-NGX documents.

## Configuration

The URL and token can come from positional arguments (`paperless-mcp <baseUrl> <token>`)
or from the environment. Environment variables are consulted only when the matching
argument is missing — a positional token always wins, and `PAPERLESS_API_TOKEN_FILE`
is not even read in that case. In `--http` mode the environment is the only source.

| Variable | Purpose |
| --- | --- |
| `PAPERLESS_URL` | Base URL of your Paperless-NGX instance, e.g. `https://paperless.example`. |
| `PAPERLESS_API_TOKEN` | Paperless API token. |
| `PAPERLESS_API_TOKEN_FILE` | Path to a file containing the API token. Takes precedence over `PAPERLESS_API_TOKEN`. |
| `API_KEY` | **Deprecated** alias for `PAPERLESS_API_TOKEN`. Still honoured; logs a deprecation notice. |

`PAPERLESS_API_TOKEN_FILE` is meant for Docker/Kubernetes secrets: the file is read once
at startup, surrounding whitespace (including the trailing newline) is stripped, and an
unreadable or empty file aborts startup with a clear message that never contains the
token. A read-only mount is enough.

```yaml
services:
  paperless-mcp:
    image: paperless-mcp
    environment:
      PAPERLESS_URL: https://paperless.example
      PAPERLESS_API_TOKEN_FILE: /run/secrets/paperless_token
    secrets:
      - paperless_token
secrets:
  paperless_token:
    file: ./paperless_token.txt
```

### Logging

Operational events are written to stderr as single-line JSON. A failed request logs only
the HTTP method, a normalized endpoint class (`/documents/:id/`), the HTTP status, the
duration in milliseconds and an error class:

```json
{"level":"error","event":"paperless_request_failed","method":"GET","endpoint":"/documents/:id/","status":500,"duration_ms":34,"error_class":"HttpStatusError"}
```

Tokens, authorization headers, request bodies, uploaded files, document titles/content
and raw Paperless responses are never logged.

## Example Usage

Here are some things you can ask Claude to do:

- "Show me all documents tagged as 'Invoice'"
- "Search for documents containing 'tax return'"
- "Create a new tag called 'Receipts' with color #FF0000"
- "Download document #123"
- "List all correspondents"
- "Create a new document type called 'Bank Statement'"

## Available Tools

### Document Operations

> There is no `list_documents` tool. Use `search_documents` (below) to enumerate
> documents; it takes the same `page`/`page_size` arguments and omits the OCR
> content from each result.

#### get_document
Get a specific document by ID.

Parameters:
- id: Document ID

```typescript
get_document({
  id: 123
})
```

#### update_document
Update metadata on an existing document. Use this to correct the document date, title, correspondent, type, or tags after a document has been added to Paperless-NGX.

> **Note on tags:** The `tags` parameter is a full replacement — it overwrites all existing tags on the document. To add or remove individual tags without affecting others, use `bulk_edit_documents` with `add_tag` or `remove_tag` instead.

Parameters:
- id: Document ID to update
- title (optional): New title for the document
- created (optional): Document date in ISO format (YYYY-MM-DD). Corrects the date to match the actual document date, not the scan/upload date.
- correspondent (optional): ID of a correspondent, or null to clear
- document_type (optional): ID of a document type, or null to clear
- storage_path (optional): ID of a storage path, or null to use default
- tags (optional): Full list of tag IDs to assign — replaces all existing tags
- archive_serial_number (optional): Archive serial number, or null to clear

```typescript
// Fix a document date and assign a correspondent
update_document({
  id: 123,
  created: "2024-11-18",
  correspondent: 7
})

// Update title and document type
update_document({
  id: 456,
  title: "Annual Pension Statement 2025",
  document_type: 3
})

// Replace all tags
update_document({
  id: 789,
  tags: [2, 5, 11]
})
```

#### search_documents
Full-text search across documents.

Parameters:
- query: Search query string

```typescript
search_documents({
  query: "invoice 2024"
})
```

#### download_document
Download a document file by ID.

Parameters:
- id: Document ID
- original (optional): If true, downloads original file instead of archived version

```typescript
download_document({
  id: 123,
  original: false
})
```

#### bulk_edit_documents
Perform bulk operations on multiple documents.

Parameters:
- documents: Array of document IDs
- method: One of:
  - set_correspondent: Set correspondent for documents
  - set_document_type: Set document type for documents
  - set_storage_path: Set storage path for documents
  - add_tag: Add a tag to documents
  - remove_tag: Remove a tag from documents
  - modify_tags: Add and/or remove multiple tags
  - delete: Delete documents
  - reprocess: Reprocess documents
  - set_permissions: Set document permissions
  - merge: Merge multiple documents
  - split: Split a document into multiple documents
  - rotate: Rotate document pages
  - delete_pages: Delete specific pages from a document
- Additional parameters based on method:
  - correspondent: ID for set_correspondent
  - document_type: ID for set_document_type
  - storage_path: ID for set_storage_path
  - tag: ID for add_tag/remove_tag
  - add_tags: Array of tag IDs for modify_tags
  - remove_tags: Array of tag IDs for modify_tags
  - permissions: Object for set_permissions with owner, permissions, merge flag
  - metadata_document_id: ID for merge to specify metadata source
  - delete_originals: Boolean for merge/split
  - pages: String for split "[1,2-3,4,5-7]" or delete_pages "[2,3,4]"
  - degrees: Number for rotate (90, 180, or 270)

Examples:
```typescript
// Add a tag to multiple documents
bulk_edit_documents({
  documents: [1, 2, 3],
  method: "add_tag",
  tag: 5
})

// Set correspondent and document type
bulk_edit_documents({
  documents: [4, 5],
  method: "set_correspondent",
  correspondent: 2
})

// Merge documents
bulk_edit_documents({
  documents: [6, 7, 8],
  method: "merge",
  metadata_document_id: 6,
  delete_originals: true
})

// Split document into parts
bulk_edit_documents({
  documents: [9],
  method: "split",
  pages: "[1-2,3-4,5]"
})

// Modify multiple tags at once
bulk_edit_documents({
  documents: [10, 11],
  method: "modify_tags",
  add_tags: [1, 2],
  remove_tags: [3, 4]
})
```

#### post_document
Upload a new document to Paperless-NGX.

Parameters:
- file: Base64 encoded file content
- filename: Name of the file
- title (optional): Title for the document
- created (optional): DateTime when the document was created (e.g. "2024-01-19" or "2024-01-19 06:15:00+02:00")
- correspondent (optional): ID of a correspondent
- document_type (optional): ID of a document type
- storage_path (optional): ID of a storage path
- tags (optional): Array of tag IDs
- archive_serial_number (optional): Archive serial number
- custom_fields (optional): Array of custom field IDs

```typescript
post_document({
  file: "base64_encoded_content",
  filename: "invoice.pdf",
  title: "January Invoice",
  created: "2024-01-19",
  correspondent: 1,
  document_type: 2,
  tags: [1, 3],
  archive_serial_number: "2024-001"
})
```

### Tag Operations

#### list_tags
Get tags. Results are paginated (25 per page by default).

Parameters:
- page (optional): 1-based page number to retrieve
- page_size (optional): Number of results per page (e.g. 1000 to fetch all in one call)

```typescript
list_tags()
list_tags({ page: 2 })
list_tags({ page_size: 1000 })
```

#### get_tag
Get a single tag by ID. Useful for resolving a tag name from an ID referenced by a document when the tag is beyond the first page of `list_tags`.

Parameters:
- id: Tag ID

```typescript
get_tag({ id: 3 })
```

#### create_tag
Create a new tag.

Parameters:
- name: Tag name
- color (optional): Hex color code (e.g. "#ff0000")
- match (optional): Text pattern to match
- matching_algorithm (optional): One of "any", "all", "exact", "regular expression", "fuzzy"

```typescript
create_tag({
  name: "Invoice",
  color: "#ff0000",
  match: "invoice",
  matching_algorithm: "fuzzy"
})
```

### Correspondent Operations

#### list_correspondents
Get correspondents. Results are paginated (25 per page by default).

Parameters:
- page (optional): 1-based page number to retrieve
- page_size (optional): Number of results per page (e.g. 1000 to fetch all in one call)

```typescript
list_correspondents()
list_correspondents({ page: 2 })
list_correspondents({ page_size: 1000 })
```

#### get_correspondent
Get a single correspondent by ID. Useful for resolving a correspondent name from an ID referenced by a document when it is beyond the first page of `list_correspondents`.

Parameters:
- id: Correspondent ID

```typescript
get_correspondent({ id: 7 })
```

#### create_correspondent
Create a new correspondent.

Parameters:
- name: Correspondent name
- match (optional): Text pattern to match
- matching_algorithm (optional): One of "any", "all", "exact", "regular expression", "fuzzy"

```typescript
create_correspondent({
  name: "ACME Corp",
  match: "ACME",
  matching_algorithm: "fuzzy"
})
```

### Document Type Operations

#### list_document_types
Get document types. Results are paginated (25 per page by default).

Parameters:
- page (optional): 1-based page number to retrieve
- page_size (optional): Number of results per page (e.g. 1000 to fetch all in one call)

```typescript
list_document_types()
list_document_types({ page: 2 })
list_document_types({ page_size: 1000 })
```

#### get_document_type
Get a single document type by ID. Useful for resolving a document type name from an ID referenced by a document when it is beyond the first page of `list_document_types`.

Parameters:
- id: Document type ID

```typescript
get_document_type({ id: 2 })
```

#### create_document_type
Create a new document type.

Parameters:
- name: Document type name
- match (optional): Text pattern to match
- matching_algorithm (optional): One of "any", "all", "exact", "regular expression", "fuzzy"

```typescript
create_document_type({
  name: "Invoice",
  match: "invoice total amount due",
  matching_algorithm: "any"
})
```

## Error Handling

The server will show clear error messages if:
- The Paperless-NGX URL or API token is incorrect
- The Paperless-NGX server is unreachable
- The requested operation fails
- The provided parameters are invalid
- The instance does not support the REST API version this client requests
  (see [Supported versions](#supported-versions)) — the error names the API
  version the instance offers and what to upgrade, without echoing the
  upstream response

## Development

Want to contribute or modify the server? Here's what you need to know:

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

3. Make your changes under `src/`
4. Run the quality gate (see [Testing](#testing))
5. Try the server locally:
```bash
npm run start -- http://localhost:8000 your-test-token
```

The server is built with:
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk): the official MCP TypeScript SDK
- [zod](https://github.com/colinhacks/zod): TypeScript-first schema validation

## Testing

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest, unit tests only, no network
npm run build       # tsc -> build/index.js (the published bin)
npm run audit:prod  # npm audit --omit=dev --audit-level=high
```

The same four steps run in CI (`.github/workflows/ci.yml`) on every pull
request and on pushes to `main`, on Node.js 22 and 24.

Unit tests mock `fetch`; the default test run never talks to a Paperless
instance. They cover pagination query building, zod argument validation, MCP
result conversion, upload form-data assembly, download handling, HTTP error
mapping, API version negotiation, and a full `McpServer` ↔ `Client` round trip
over an in-memory transport.

### Integration tests

The integration tests in `tests/integration/` run against a real Paperless-ngx
instance. They are **opt-in**: without `PAPERLESS_TEST_URL` they skip
themselves, so they are not part of the CI quality gate.

Point them at a **disposable** instance (a throwaway container, not your
production archive), even though they only ever create their own fixtures:

```bash
PAPERLESS_TEST_URL=http://localhost:8000 \
PAPERLESS_TEST_TOKEN=<API_TOKEN> \
npm run test:integration
```

| Variable | Meaning |
| --- | --- |
| `PAPERLESS_TEST_URL` | Base URL of the test instance. Unset ⇒ all integration tests skip. |
| `PAPERLESS_TEST_TOKEN` | API token for that instance. Required when the URL is set. |
| `PAPERLESS_TEST_UPLOAD` | Set to `1` to also run the document upload/consume test. Needs a running consumer and takes up to two minutes. |

What they do:

- verify that the instance offers API version 9 or newer, and that requesting
  an unsupported version fails with our actionable error and no upstream data
- exercise the read-only workflow: list documents/tags/correspondents/document
  types with pagination, search, and fetch single objects
- create, read, update and delete synthetic fixtures only — every object is
  named `mcp-it-<random>-…` and is removed again in the cleanup hook, including
  on failure. Pre-existing objects are never modified.

## API Documentation

This MCP server implements endpoints from the Paperless-NGX REST API. For more details about the underlying API, see the [official documentation](https://docs.paperless-ngx.com/api/).

## Running the MCP Server

The MCP server can be run in two modes:

### 1. stdio (default)

This is the default mode. The server communicates over stdio, suitable for CLI and direct integrations.

```
npm run start -- <baseUrl> <token>
```

### 2. HTTP (Streamable HTTP Transport)

To run the server as an HTTP service, use the `--http` flag. You can also specify the port with `--port` (default: 3000). This mode requires [Express](https://expressjs.com/) to be installed (it is included as a dependency).

In `--http` mode the URL and token are read from the environment only — positional
arguments are ignored. See [Configuration](#configuration).

```
PAPERLESS_URL=http://localhost:8000 PAPERLESS_API_TOKEN=<token> \
  npm run start -- --http --port 3000
```

- The MCP API will be available at `POST /mcp` on the specified port.
- Each request is handled statelessly, following the [StreamableHTTPServerTransport](https://github.com/modelcontextprotocol/typescript-sdk) pattern.
- GET and DELETE requests to `/mcp` will return 405 Method Not Allowed.
