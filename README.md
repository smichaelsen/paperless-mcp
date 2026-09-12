# Paperless-NGX MCP Server

An MCP (Model Context Protocol) server for interacting with a Paperless-NGX API server. This server provides tools for managing documents, tags, correspondents, and document types in your Paperless-NGX instance.

> [!IMPORTANT]
> **Breaking change — the server now starts read-only.**
>
> Every tool that can change your Paperless instance (`post_document`,
> `update_document`, `create_*`, `update_tag`, `bulk_edit_*`, `delete_tag`) is
> **absent from `tools/list`** until you opt in. An existing installation that
> is not changed keeps working, but can only read.
>
> To restore exactly the behaviour of earlier versions, start the server with
> **both** switches:
>
> ```bash
> PAPERLESS_ALLOW_WRITES=true PAPERLESS_ALLOW_DESTRUCTIVE=true paperless-mcp …
> # or:  paperless-mcp … --allow-writes --allow-destructive
> ```
>
> To let the assistant file and tag documents without ever being able to delete
> one, set only `PAPERLESS_ALLOW_WRITES=true`. See
> [Tool access modes](#tool-access-modes).

> [!IMPORTANT]
> **Breaking change — `--http` now authenticates, and binds loopback.**
>
> The HTTP listener used to bind every interface with no authentication, so
> anyone who could reach the port could drive the full tool surface. Three
> things changed:
>
> - it **refuses to start** without a bearer secret in
>   `PAPERLESS_MCP_AUTH_TOKEN_FILE` (or `PAPERLESS_MCP_AUTH_TOKEN`), and every
>   request must carry `Authorization: Bearer <secret>`;
> - it binds **`127.0.0.1`** unless `PAPERLESS_MCP_BIND_ADDRESS` says otherwise
>   — a container needs `PAPERLESS_MCP_BIND_ADDRESS=0.0.0.0` to be reachable
>   from its network at all;
> - the deprecated `GET /sse` + `POST /messages` routes are gone unless
>   `PAPERLESS_MCP_ENABLE_LEGACY_SSE` is set.
>
> `PAPERLESS_MCP_ALLOW_UNAUTHENTICATED=true` restores the old open behaviour on
> a loopback bind. See [Authentication](#authentication).
>
> `stdio` mode is unaffected.

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
| `PAPERLESS_ALLOW_WRITES` | Register the write-class tools. Off by default — see [Tool access modes](#tool-access-modes). |
| `PAPERLESS_ALLOW_DESTRUCTIVE` | Register the destructive-class tools. Off by default, and never implied by `PAPERLESS_ALLOW_WRITES`. |
| `PAPERLESS_MCP_AUTH_TOKEN_FILE` | **`--http` only, required.** Path to a file containing the bearer secret clients must present. Takes precedence over `PAPERLESS_MCP_AUTH_TOKEN`. |
| `PAPERLESS_MCP_AUTH_TOKEN` | `--http` only. The bearer secret inline. Prefer the `_FILE` form. |
| `PAPERLESS_MCP_ALLOW_UNAUTHENTICATED` | `--http` only. Explicitly start **without** authentication. Refused unless the bind address is loopback. |
| `PAPERLESS_MCP_BIND_ADDRESS` | `--http` only. Interface the listener binds to. Default `127.0.0.1` — loopback only. |
| `PAPERLESS_MCP_ENABLE_LEGACY_SSE` | `--http` only. Register the deprecated `GET /sse` + `POST /messages` routes. Off by default. |
| `PAPERLESS_MCP_MAX_BODY` | `--http` only. Largest accepted JSON body, e.g. `10mb` (the default) or `512kb`. |
| `PAPERLESS_MCP_RATE_LIMIT_MAX` | `--http` only. Requests per window per client address. Default `600`; `0` disables rate limiting. |
| `PAPERLESS_MCP_RATE_LIMIT_WINDOW_MS` | `--http` only. Length of the rate-limit window in milliseconds. Default `60000`. |
| `PAPERLESS_MCP_ALLOWED_HOSTS` | `--http` only. Comma-separated hostnames accepted in the `Host` header (ports ignored). **Replaces** the default `localhost,127.0.0.1,[::1]` rather than extending it. `*` disables the check. |
| `PAPERLESS_MCP_ALLOWED_ORIGINS` | `--http` only. Comma-separated origins accepted in the `Origin` header. Default: none — a request carrying *any* `Origin` is rejected, while requests without one (every non-browser MCP client) pass. `*` disables the check. |

`PAPERLESS_API_TOKEN_FILE` and `PAPERLESS_MCP_AUTH_TOKEN_FILE` are meant for
Docker/Kubernetes secrets: the file is read once at startup, surrounding whitespace
(including the trailing newline) is stripped, and an unreadable or empty file aborts
startup with a clear message that never contains the secret. A read-only mount is
enough. Neither secret can be passed on the command line — an argument is visible in
`ps`, in shell history and in `docker inspect`.

```yaml
services:
  paperless-mcp:
    image: paperless-mcp
    # No `ports:` — nothing is published to the host. Other services on this
    # network reach the server at http://paperless-mcp:3000/mcp; anything
    # outside it goes through a reverse proxy that terminates TLS.
    expose:
      - "3000"
    environment:
      PAPERLESS_URL: https://paperless.example
      PAPERLESS_API_TOKEN_FILE: /run/secrets/paperless_token
      PAPERLESS_MCP_AUTH_TOKEN_FILE: /run/secrets/paperless_mcp_auth
      # Inside a container the listener has to bind the container's own
      # interface to be reachable from the compose network at all. The network
      # is the boundary here, and the bearer secret is the access control.
      PAPERLESS_MCP_BIND_ADDRESS: 0.0.0.0
      PAPERLESS_MCP_ALLOWED_HOSTS: paperless-mcp,localhost,127.0.0.1,[::1]
    secrets:
      - paperless_token
      - paperless_mcp_auth
secrets:
  paperless_token:
    file: ./paperless_token.txt
  paperless_mcp_auth:
    file: ./paperless_mcp_auth.txt
```

Generate the bearer secret with something like `openssl rand -base64 32 > paperless_mcp_auth.txt`.

### Logging

Operational events are written to stderr as single-line JSON. A failed request logs only
the HTTP method, a normalized endpoint class (`/documents/:id/`), the HTTP status, the
duration in milliseconds and an error class:

```json
{"level":"error","event":"paperless_request_failed","method":"GET","endpoint":"/documents/:id/","status":500,"duration_ms":34,"error_class":"HttpStatusError"}
```

Tokens, authorization headers, request bodies, uploaded files, document titles/content
and raw Paperless responses are never logged.

## Tool access modes

Every tool belongs to exactly one access class:

- **read** — cannot change anything in Paperless.
- **write** — creates or updates objects. Never deletes one, never replaces a
  permission set.
- **destructive** — deletes documents, pages or objects, or replaces
  permissions. Effects that cannot be undone from this server.

The process starts **read-only**, and the two opt-ins are independent:
enabling writes does *not* enable destructive operations. Whatever is not
enabled is **never registered**, so it is absent from `tools/list` rather than
advertised-and-refusing — a model cannot ask for a tool it cannot see, and your
client's allowlist has less to cover.

| Mode | Start it with | Tools advertised |
| --- | --- | --- |
| **read-only** (default) | nothing to set | **9** |
| **write** | `PAPERLESS_ALLOW_WRITES=true` or `--allow-writes` | **16** |
| **destructive** | additionally `PAPERLESS_ALLOW_DESTRUCTIVE=true` or `--allow-destructive` | **20** |

| Variable | Flag | Purpose |
| --- | --- | --- |
| `PAPERLESS_ALLOW_WRITES` | `--allow-writes` | Register the write-class tools. |
| `PAPERLESS_ALLOW_DESTRUCTIVE` | `--allow-destructive` | Register the destructive-class tools. Never implied by `PAPERLESS_ALLOW_WRITES`. |

The flags may appear anywhere on the command line: flags (and the value after
`--port`) are no longer mistaken for the positional `<baseUrl> <token>`, so
`paperless-mcp --allow-writes` with `PAPERLESS_URL` and `PAPERLESS_API_TOKEN`
in the environment works as expected.

Accepted true values are `1`, `true`, `yes`, `y`, `on`, `enable`, `enabled`
(case-insensitive). Anything unrecognized is treated as **off** and logged:
a typo must never widen what the server exposes. `PAPERLESS_ALLOW_DESTRUCTIVE`
on its own also enables writes — every destructive operation is a write — and
says so in the log.

The active mode is logged once at startup:

```json
{"level":"info","event":"tool_access_mode","mode":"write","writes":true,"destructive":false,"tools":16}
```

### Tool classification

| Tool | Class | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| --- | --- | --- | --- | --- |
| `get_document` | read | true | false | true |
| `search_documents` | read | true | false | true |
| `download_document` | read | true | false | true |
| `list_tags` | read | true | false | true |
| `get_tag` | read | true | false | true |
| `list_correspondents` | read | true | false | true |
| `get_correspondent` | read | true | false | true |
| `list_document_types` | read | true | false | true |
| `get_document_type` | read | true | false | true |
| `post_document` | write | false | false | false |
| `create_tag` | write | false | false | false |
| `create_correspondent` | write | false | false | false |
| `create_document_type` | write | false | false | false |
| `update_document` | write | false | true | true |
| `update_tag` | write | false | true | true |
| `bulk_edit_documents` | write (narrowed) / destructive | false | true | false |
| `delete_tag` | destructive | false | true | true |
| `bulk_edit_tags` | destructive | false | true | true |
| `bulk_edit_correspondents` | destructive | false | true | true |
| `bulk_edit_document_types` | destructive | false | true | true |

`openWorldHint` is `false` for every tool: they all talk to exactly one
configured Paperless instance.

`update_*` are marked destructive because they overwrite: `tags` replaces the
whole tag list, and the nullable relations clear a field outright. The
`bulk_edit_*` object tools are destructive in *both* their operations —
`delete` removes the objects, and `set_permissions` with `merge: false`
replaces the permission set.

### `bulk_edit_documents`

This is the one tool whose destructiveness depends on an argument: the same
`method` enum spans setting a correspondent and permanently deleting documents.
It is therefore registered with a **narrowed contract** in write mode:

- `method` offers only `set_correspondent`, `set_document_type`,
  `set_storage_path`, `add_tag`, `remove_tag`, `modify_tags`, `reprocess`,
  `merge`, `split`, `rotate`;
- `delete`, `delete_pages` and `set_permissions` are not in the advertised enum
  and are refused by the handler as well;
- the `delete_originals` and `permissions` arguments are removed from the
  schema, and `merge`/`split` are sent with an explicit
  `delete_originals: false` — so they create a new document and leave the
  originals in place;
- `pages` stays, because Paperless requires it to `split` (it is redescribed
  for that use). On its own it does nothing: the method that would delete pages
  is not reachable.

With `PAPERLESS_ALLOW_DESTRUCTIVE` the full enum and all arguments come back.

### Recommended client allowlist

Server-side gating decides what *exists*; the client's allowlist decides what
runs without asking. A read-only server cannot change or destroy anything,
which makes the read class the only one worth auto-approving at all — but
read-only is not the same as harmless. `search_documents` and
`download_document` return the contents of your documents, so a prompt
injection hidden in a scanned document can use them to find sensitive material
and hand it to whatever *other* tool the assistant has for sending data out
(web requests, mail, shell). Auto-approve them only where you would accept
that, and be deliberate about what else is in the same session.

With that caveat, the read class is what an allowlist should contain:

```
paperless:get_document, paperless:search_documents, paperless:download_document,
paperless:list_tags, paperless:get_tag, paperless:list_correspondents,
paperless:get_correspondent, paperless:list_document_types, paperless:get_document_type
```

Run the narrowest mode each client needs, rather than one permissive server for
everything:

- an assistant that answers questions about your documents → read-only;
- an assistant that files and tags incoming mail → `--allow-writes`, allowlist
  the read tools plus `post_document`, `update_document` and `create_*`;
- a cleanup session → `--allow-destructive`, allowlist nothing.

### Approval policy

- **Auto-approve** the read class only, and only with the exfiltration caveat
  above in mind.
- **Ask every time** for the write class. `update_document` and
  `bulk_edit_documents` act on many documents at once; see the `documents`
  array before it runs.
- **Ask, and read the arguments**, for the destructive class. Nothing here can
  be undone from this server: `delete_tag` strips the tag from every document
  that uses it, `bulk_edit_documents` with `delete` removes documents
  permanently, and `set_permissions` with `merge: false` replaces an existing
  permission set rather than adding to it.
- Keep destructive operations out of any unattended or scheduled run: start
  those processes without `PAPERLESS_ALLOW_DESTRUCTIVE` so the tools are not
  there to be called.
- Give the MCP server its own Paperless account with only the permissions it
  needs. The access mode is a guard rail in this process; the Paperless
  permission model is the one an attacker cannot argue with.

## Example Usage

Here are some things you can ask Claude to do:

- "Show me all documents tagged as 'Invoice'"
- "Search for documents containing 'tax return'"
- "Create a new tag called 'Receipts' with color #FF0000"
- "Download document #123"
- "List all correspondents"
- "Create a new document type called 'Bank Statement'"

## Available Tools

Which of these a client actually sees depends on the access mode: by default
only the read class is registered. See
[Tool access modes](#tool-access-modes) for the classification of every tool
and for the narrowed `bulk_edit_documents` contract in write mode.

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

The MCP server can be run over two transports. Both honour `--allow-writes` and
`--allow-destructive` (and their environment equivalents); without them the
server is read-only — see [Tool access modes](#tool-access-modes).

### 1. stdio (default)

This is the default mode. The server communicates over stdio, suitable for CLI and direct integrations.

```
npm run start -- <baseUrl> <token>
```

### 2. HTTP (Streamable HTTP Transport)

To run the server as an HTTP service, use the `--http` flag. You can also specify the port with `--port` (default: 3000). This mode requires [Express](https://expressjs.com/) to be installed (it is included as a dependency).

In `--http` mode the URL and token are read from the environment only — positional
arguments are ignored. See [Configuration](#configuration).

`--http` **requires a bearer secret** and refuses to start without one:

```
PAPERLESS_URL=http://localhost:8000 \
PAPERLESS_API_TOKEN_FILE=/run/secrets/paperless_token \
PAPERLESS_MCP_AUTH_TOKEN_FILE=/run/secrets/paperless_mcp_auth \
  npm run start -- --http --port 3000
```

- The MCP API will be available at `POST /mcp` on the specified port.
- The listener binds `127.0.0.1` — **loopback only** — unless `PAPERLESS_MCP_BIND_ADDRESS` says otherwise.
- Every request must carry `Authorization: Bearer <secret>`.
- Each request is handled statelessly, following the [StreamableHTTPServerTransport](https://github.com/modelcontextprotocol/typescript-sdk) pattern.
- GET and DELETE requests to `/mcp` will return 405 Method Not Allowed.
- The deprecated `GET /sse` + `POST /messages` routes are **not registered** unless `PAPERLESS_MCP_ENABLE_LEGACY_SSE` is set.

#### Authentication

The HTTP listener hands out the whole enabled tool surface — and it holds a Paperless
API token — so it authenticates every MCP transport route with a shared bearer secret.

```
curl -s http://127.0.0.1:3000/mcp \
  -H "Authorization: Bearer <SECRET>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'
```

- The secret comes from `PAPERLESS_MCP_AUTH_TOKEN_FILE` (preferred) or
  `PAPERLESS_MCP_AUTH_TOKEN`. There is no CLI flag on purpose.
- A missing, malformed, wrong or duplicated credential all get the **same** `401` with
  the same body and a `WWW-Authenticate: Bearer` header. Nothing distinguishes them —
  telling "malformed" from "wrong" would tell a prober which half of its guess to fix.
- The comparison is constant time (`crypto.timingSafeEqual` over SHA-256 digests, so a
  length mismatch neither throws nor leaks the secret's length).
- The secret is registered with the log redactor. It — and the `Authorization` header —
  never appear in a log line.
- Rate limiting runs **before** authentication, so the secret cannot be guessed at line
  rate.

> [!IMPORTANT]
> `--http` exits with a message rather than starting unauthenticated. If you genuinely
> want an open listener — local development, nothing else on the machine — set
> `PAPERLESS_MCP_ALLOW_UNAUTHENTICATED=true`. It is refused in combination with a
> non-loopback `PAPERLESS_MCP_BIND_ADDRESS`.

#### Network exposure and TLS

The listener binds `127.0.0.1` by default: nothing outside this host can reach it, and
the documented Compose deployment publishes no host port at all. Reaching it from
elsewhere is an explicit opt-in:

```
PAPERLESS_MCP_BIND_ADDRESS=0.0.0.0
```

which logs a `http_bind_not_loopback` warning at startup, because from that moment the
port is only as private as the network around it.

**This server speaks plain HTTP and does not terminate TLS.** Anything beyond loopback —
and certainly anything beyond a trusted private network — must go through a reverse
proxy (nginx, Caddy, Traefik) or a tunnel (Cloudflare Tunnel, Tailscale) that terminates
TLS and forwards to the listener. Without that, the bearer secret crosses the wire in
clear text on every request.

If the proxy reaches the server under a name other than a loopback one, add it to
`PAPERLESS_MCP_ALLOWED_HOSTS` — see below.

#### Rate and body-size limits

| | Default | Variable |
| --- | --- | --- |
| Max JSON body | `10mb` | `PAPERLESS_MCP_MAX_BODY` |
| Requests per window | `600` | `PAPERLESS_MCP_RATE_LIMIT_MAX` (`0` disables) |
| Window | `60000` ms | `PAPERLESS_MCP_RATE_LIMIT_WINDOW_MS` |

The body limit is deliberately generous: `post_document` carries the uploaded file
**base64-encoded inside the JSON-RPC body**, so Express's own 100 kB default capped
every upload at roughly 74 kB of actual file. `10mb` is about 7.5 MB of file. A
read-only deployment — the default access mode — never needs more than a few kilobytes
and can turn it right down.

Over-limit bodies get `413`, unparseable ones `400`, and too many requests `429` with a
`Retry-After` header — all as JSON-RPC error objects rather than Express's HTML error
page.

Rate limiting keys on the client's TCP source address. `X-Forwarded-For` is deliberately
**not** honoured: it is a plain request header, so trusting it would let any caller pick
its own bucket. Behind a reverse proxy every request therefore shares the proxy's
address and the limit is effectively global — still a useful flood ceiling, but size it
for the whole deployment rather than per client.

#### Client isolation

Every connection gets its own `McpServer` and its own transport; no mutable server,
transport or session state is shared between clients. For Streamable HTTP a connection
is a single request — the mode is stateless, so no `Mcp-Session-Id` is issued and there
is no session table to leak or expire. The legacy `GET /sse` route keeps one server per
event stream, closed with the stream.

#### DNS-rebinding protection

Any web page can POST to `http://localhost:3000/mcp`, so the `Host` and `Origin` headers
are validated before a request reaches a transport. By default only loopback *hostnames*
are accepted and every browser origin is rejected; see `PAPERLESS_MCP_ALLOWED_HOSTS` and
`PAPERLESS_MCP_ALLOWED_ORIGINS` under [Configuration](#configuration).

> [!NOTE]
> This is a header check, **not** an access control and **not** a network restriction —
> the `Host` header is written by the caller. It used to be the only thing standing
> between the network and the tool surface, and it was not enough: the listener bound
> all interfaces, so another host on the LAN sending `Host: localhost` got a `200` with
> full `serverInfo`. That is closed now by the loopback default bind and by bearer
> authentication. What this check contributes is the DNS-rebinding case specifically: a
> browser cannot be tricked into driving the server from a page on another origin.

If you reach the server under any other name — a Docker service name, a reverse proxy —
add it, otherwise requests are answered with `403`. The variable **replaces** the default
list rather than extending it, so keep the loopback names if you still connect that way:

```
PAPERLESS_MCP_ALLOWED_HOSTS=localhost,127.0.0.1,[::1],paperless-mcp
```

The allowlists in effect are printed at startup:

```json
{"level":"info","event":"http_server_listening","address":"127.0.0.1","port":3000,"transport":"streamable-http","session_mode":"stateless","auth":"bearer (PAPERLESS_MCP_AUTH_TOKEN_FILE)","legacy_sse":"disabled","max_body":"10mb","rate_limit":"600/60000ms","allowed_hosts":"localhost,127.0.0.1,[::1]","allowed_origins":"(none)"}
```
