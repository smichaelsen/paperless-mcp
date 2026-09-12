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

> [!IMPORTANT]
> **Check that the package is on npm before you install it:**
>
> ```bash
> npm view @smichaelsen/paperless-mcp version
> ```
>
> An `E404` means no release has been cut yet and `npm install` cannot work; use
> [From a Git checkout](#from-a-git-checkout) or the
> [container image](#container-deployment) instead. A version number means you
> are good to go. (No release existed when this section was written — see
> [RELEASING.md](RELEASING.md) for what cutting one involves.)
>
> Do not fall back to the unscoped name `paperless-mcp`, which earlier versions
> of this README told you to install: that is *upstream's* package, unpublished
> on 2024-12-28 and returning `404` ever since. It is not this project and never
> was.

1. Install the MCP server:
```bash
npm install -g @smichaelsen/paperless-mcp
```

2. Add it to your Claude's MCP configuration:

For VSCode extension, edit `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`:
```json
{
  "mcpServers": {
    "paperless": {
      "command": "npx",
      "args": ["-y", "@smichaelsen/paperless-mcp", "http://your-paperless-instance:8000", "your-api-token"]
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
      "args": ["-y", "@smichaelsen/paperless-mcp", "http://your-paperless-instance:8000", "your-api-token"]
    }
  }
}
```

The package installs a single executable called `paperless-mcp`, so after a
global install you can also point `command` straight at `paperless-mcp` and
drop the package name from `args`.

3. Get your API token:
   1. Log into your Paperless-NGX instance
   2. Click your username in the top right
   3. Select "My Profile"
   4. Click the circular arrow button to generate a new token

4. Replace the placeholders in your MCP config:
   - `http://your-paperless-instance:8000` with your Paperless-NGX URL
   - `your-api-token` with the token you just generated

That's it! Now you can ask Claude to help you manage your Paperless-NGX documents.

#### From a Git checkout

Works today, and is what you want either way if you intend to change anything:

```bash
git clone https://github.com/smichaelsen/paperless-mcp.git
cd paperless-mcp
npm ci
npm run build
npm link          # puts `paperless-mcp` on your PATH, pointing at this checkout
```

Then use `"command": "paperless-mcp"` with no package name in `args`, or point
`command` straight at `<checkout>/build/index.js` with `node`.

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
    image: ghcr.io/smichaelsen/paperless-mcp:latest
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

## Container deployment

### The image

`Dockerfile` builds a three-stage image whose final stage contains the compiled
JavaScript, the production dependency tree, and nothing else.

| | |
| --- | --- |
| Base | `node:24-bookworm-slim`, **pinned by digest** |
| Runs as | `node` (uid 1000) — never root |
| Not in the final stage | TypeScript, vitest, ts-node, the `src/` tree, the test suite, npm/npx/corepack |
| Writable paths | none; the Compose example mounts the root filesystem read-only |
| Persistent state | none — no volume is needed, and deleting the container loses nothing |

**Why Node 24 and why a digest.** Node 20 reached end of life in April 2026, so
the previous `node:20-slim` base had stopped getting security fixes; 24 is the
active LTS line and CI runs the suite on both 22 and 24. The base is pinned by
the digest of the multi-arch OCI *index* (so it still resolves on amd64 and
arm64) rather than by the tag alone, because `node:24-bookworm-slim` names a
different image every few days — a tag-only pin makes builds unreproducible and
makes "what is actually running in production" unanswerable. The tag is kept
next to the digest as documentation; Docker uses the digest. Dependabot
(`.github/dependabot.yml`) watches npm, this Dockerfile and the GitHub Actions
used by CI, and opens a PR when any of them moves — which is what makes a digest
pin maintainable rather than a way to freeze in old Debian packages.

npm, npx and corepack are deleted from the final stage: a running MCP server
never uses them, npm carries a large dependency tree of its own that would show
up in every image scan, and a process that manages to execute in the container
then has no package installer to hand.

```
docker build -t paperless-mcp .

docker run --rm --init \
  -e PAPERLESS_URL=https://paperless.example \
  -e PAPERLESS_API_TOKEN=<token> \
  -p 127.0.0.1:3000:3000 \
  paperless-mcp
```

`--init` matters: PID 1 in this image is `node`, and the kernel applies no
default signal action to PID 1, so without an init `docker stop` waits for the
full timeout and then SIGKILLs. The Compose example sets `init: true`.

### The published image

Every push to `main` builds the image and pushes it to the GitHub Container
Registry (`.github/workflows/docker-publish.yml`):

```bash
docker pull ghcr.io/smichaelsen/paperless-mcp:latest
```

Two tags are published: `latest`, and the branch name `main`. They point at the
same digest. There is no version tag yet — the image tracks `main`, not a
release.

> [!NOTE]
> Before the fix in [#28](https://github.com/smichaelsen/paperless-mcp/issues/28)
> the workflow pushed to `ghcr.io/smichaelsen/smichaelsen/paperless-mcp`: the
> owner segment was doubled, because the inherited upstream workflow joined
> `github.actor` with `github.repository`, and the latter already contains the
> owner. That older path still exists in the registry and is frozen at whatever
> was last pushed to it. Pull the single-owner path above.
>
> The corrected path is a **new** package, created by the first push to `main`
> after that fix. GitHub may create it as private, in which case an anonymous
> `docker pull` is denied until its visibility is switched to public under
> *Packages → paperless-mcp → Package settings*. Check that once, after the
> first push.

### Hardened Compose example

[`compose.example.yaml`](compose.example.yaml) is the recommended deployment.
Copy it to `compose.yaml`, create the two secret files it documents, and adjust
`PAPERLESS_URL`.

| Control | Setting |
| --- | --- |
| Published host port | **none** — `expose: ["3000"]`, no `ports:` |
| Root filesystem | `read_only: true`, with a single `noexec,nosuid,nodev` tmpfs on `/tmp` |
| Capabilities | `cap_drop: [ALL]` |
| Privilege escalation | `security_opt: [no-new-privileges:true]` |
| User | `user: "1000:1000"`, on top of the image's own `USER node` |
| Resources | 1 CPU, 256 MB, 128 PIDs |
| Restart policy | `unless-stopped` |
| Log rotation | `json-file`, 10 MB × 3 |
| Docker socket | not mounted |
| Application-data mounts | none — the only mounts are the two read-only secret files |
| Secrets | Docker secrets via `PAPERLESS_API_TOKEN_FILE` and `PAPERLESS_MCP_AUTH_TOKEN_FILE` |

Nothing is published to the host, so the server is not reachable from the LAN
or the internet by default. Other services on the Compose network reach it at
`http://paperless-mcp:3000/mcp`; anything beyond that network goes through a
reverse proxy or tunnel attached to the same network, which is also what
terminates TLS — this server speaks plain HTTP and never terminates TLS itself.

Two settings in the file are load-bearing and easy to get wrong:

- `PAPERLESS_MCP_BIND_ADDRESS: "0.0.0.0"`. The listener binds loopback by
  default, which *inside a container* means "not reachable from the Compose
  network at all". The container network is the boundary here and the bearer
  secret is the access control.
- `PAPERLESS_MCP_ALLOWED_HOSTS` keeps the loopback names. That list **replaces**
  the default rather than extending it, and the image's `HEALTHCHECK` calls
  `http://127.0.0.1:3000/healthz` — drop `127.0.0.1` and every healthcheck
  becomes a `403`.

The tool access mode is read-only unless you say otherwise; the example has
`PAPERLESS_ALLOW_WRITES` and `PAPERLESS_ALLOW_DESTRUCTIVE` commented out so
widening the surface is a deliberate edit. See
[Tool access modes](#tool-access-modes).

### Health and readiness

| Endpoint | Question | Success | Failure |
| --- | --- | --- | --- |
| `GET /healthz` | Is this process able to serve a request? | `200 {"status":"ok"}` | — |
| `GET /readyz` | Is Paperless reachable and answering this server? | `200 {"status":"ok"}` | `503 {"status":"unavailable"}` |

They answer two different questions on purpose. `/healthz` never touches
Paperless: the only sensible reaction to it failing is a restart, and
restarting the MCP server because *Paperless* is down turns one outage into a
crash loop. So the container `HEALTHCHECK` polls `/healthz`, while `/readyz` is
what a reverse proxy or load balancer should poll to stop routing traffic
during an upstream outage. A Paperless outage therefore leaves the container
`healthy` and `/readyz` at `503`.

**They are reachable without credentials** — a Docker `HEALTHCHECK` or a
Kubernetes probe cannot present a bearer token — so they say as little as it is
possible to say: a status code and one fixed field. No version, no Paperless
URL, no configuration, no upstream status code, no error text. Being exempt
from authentication does not put them outside the rest of the boundary: they
are registered after the app-wide middleware, so the `Host`/`Origin` check (and
the rate limiter, once it lands) applies to them exactly as it does to `/mcp`.

**`/readyz` caches its verdict**, for 10 s on success and 2 s on failure, and
concurrent requests share a single in-flight probe. Without that, an
unauthenticated endpoint would be an amplifier: one cheap request here would
mean one authenticated request to Paperless, and anyone who could reach the port
could use this server to hammer it. The shorter failure TTL is so that a
recovering Paperless is picked up quickly. The upstream check itself is the
cheapest authenticated call there is — the API root — with a 5 s deadline, and
its result is reduced to a single bit before it reaches the response.

### Smoke test

This is the check the hardened example is expected to pass, and it runs as
written from a clean checkout. It needs no real Paperless instance and no
published image: [`compose.smoke.yaml`](compose.smoke.yaml) builds the image
from the checkout and swaps in a stub upstream, changing nothing about the
hardening in `compose.example.yaml` — which is the point, since a smoke test
that relaxes what it is testing proves nothing. The stub also makes the
*outage* case producible on demand, by stopping one container.

```
# 0. The two secrets the example expects. Both filenames are in .gitignore,
#    and *.txt is in .dockerignore, so neither can reach a build context.
umask 077
printf '%s' 'not-a-real-paperless-token' > paperless_token.txt
openssl rand -base64 32 | tr -d '\n' > paperless_mcp_auth.txt

# A shorthand, since every step needs both files. A variable rather than an
# alias, so the sequence also runs verbatim from a script:
SMOKE="docker compose -f compose.example.yaml -f compose.smoke.yaml"

# 1. Build and start
$SMOKE up -d --build

# 2. Not root
$SMOKE exec paperless-mcp id
#    uid=1000(node) gid=1000(node) groups=1000(node)

# 3. No package manager and no dev dependencies. Assert on what is LEFT, not
#    on a list of what was removed — the base image ships npm *and* Yarn 1
#    under /opt, and a probe for `npm npx corepack` happily misses yarn.
$SMOKE exec paperless-mcp ls /usr/local/bin /opt
#    /opt:            (empty)
#    /usr/local/bin:  node  nodejs
$SMOKE exec paperless-mcp sh -c 'ls node_modules | grep -E "^(typescript|vitest|ts-node)$" || echo none'
#    none

# 4. Read-only root filesystem, writable tmpfs
$SMOKE exec paperless-mcp sh -c 'touch /probe'      # Read-only file system
$SMOKE exec paperless-mcp sh -c 'touch /tmp/probe'  # succeeds

# 5. Nothing published to the host
$SMOKE port paperless-mcp 3000                      # no host port

# 6. Hardening actually applied
docker inspect "$($SMOKE ps -q paperless-mcp)" \
  --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.Init}}'
#    true [ALL] [no-new-privileges:true] 268435456 128 true

# 7. The probes answer without credentials, from another container on the
#    network — nothing is published to the host. The network is <project>_mcp
#    and the example sets `name: paperless-mcp`.
docker run --rm --network paperless-mcp_mcp --entrypoint node paperless-mcp:smoke \
  -e "fetch('http://paperless-mcp:3000/healthz').then(async r=>console.log(r.status, await r.text()))"
#    200 {"status":"ok"}

# 8. ...while every MCP route refuses the same caller
docker run --rm --network paperless-mcp_mcp --entrypoint node paperless-mcp:smoke \
  -e "fetch('http://paperless-mcp:3000/mcp',{method:'POST'}).then(r=>console.log(r.status))"
#    401

# 9. Readiness follows Paperless; liveness does not.
#    Wait out the 10s success TTL first: /readyz keeps serving its last good
#    verdict until the cache expires, so probing immediately after the stop
#    correctly returns 200 and proves nothing. That caching is the feature —
#    it is what stops an unauthenticated endpoint from being an amplifier —
#    so this check has to respect it rather than race it.
$SMOKE stop fake-paperless
sleep 11
docker run --rm --network paperless-mcp_mcp --entrypoint node paperless-mcp:smoke \
  -e "const g=async p=>{const r=await fetch('http://paperless-mcp:3000/'+p);return r.status+' '+await r.text()};(async()=>{console.log('healthz ->',await g('healthz'));console.log('readyz  ->',await g('readyz'))})()"
#    healthz -> 200 {"status":"ok"}
#    readyz  -> 503 {"status":"unavailable"}
$SMOKE ps                                           # still (healthy)

# 10. Readiness does not amplify. Count upstream attempts, fire a burst,
#     count again: 30 requests in, one request out.
$SMOKE logs paperless-mcp | grep -c paperless_request_failed
docker run --rm --network paperless-mcp_mcp --entrypoint node paperless-mcp:smoke \
  -e "Promise.all(Array.from({length:30},()=>fetch('http://paperless-mcp:3000/readyz').then(r=>r.status))).then(s=>console.log([...new Set(s)]))"
$SMOKE logs paperless-mcp | grep -c paperless_request_failed

# 11. Tear down
$SMOKE down
```

Steps 3, 9 and 10 are the ones worth keeping honest.

Step 3 asserts on what remains in the image rather than enumerating what was
deleted, because an earlier version of this file removed npm, npx and corepack,
probed for exactly those three, and shipped Yarn 1 regardless. The image build
makes the same assertion itself — a `command -v` sweep across `$PATH` plus an
exact listing of the three Node tooling directories — so a base image that
reintroduces a package manager fails the build rather than this step.

Step 9's `sleep 11` is not padding. `/readyz` caches a successful verdict for
ten seconds, so for the first ten seconds after the upstream stops it still
answers `200` — correctly. Skipping the wait makes a working readiness check
look broken.

Step 10 is the amplification guard: the counter moves by exactly one across
thirty concurrent unauthenticated requests.

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
- A missing, malformed (`Basic` instead of `Bearer`, `Bearer` with nothing after it, no
  scheme at all) or simply wrong credential all get the **same** `401` with the same
  body and a `WWW-Authenticate: Bearer` header. Nothing distinguishes them — telling
  "malformed" from "wrong" would tell a prober which half of its guess to fix.
- A **duplicated** `Authorization` header is not rejected: Node keeps the first copy and
  discards the rest, so the first one is what gets authenticated. This is noted because
  it is easy to assume otherwise; it is not a weakness, since supplying a correct value
  in either position already requires the secret.
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

The tracked-address table is bounded (10,000 entries). Past that, expired windows are
swept and then the oldest live entry is evicted to make room, so an unauthenticated
caller cycling source addresses cannot grow it without limit. Eviction resets the
evicted client's counter; it never locks anyone out.

> [!NOTE]
> **The rate limiter runs before authentication, and that is a deliberate trade-off.**
> It has to: checking the credential first would make every guess cheap and turn
> authentication itself into the thing being brute-forced. The cost is that a caller who
> exhausts the window from a given source address also locks out anyone else on that
> address — including a client holding the **correct** secret, which gets `429` rather
> than `200`.
>
> On a loopback or per-client-address deployment that is barely reachable. **Behind a
> reverse proxy it matters a great deal**: every request shares the proxy's address, so
> one noisy or hostile client consumes the whole window for everyone. If you deploy
> behind a proxy, do the rate limiting *there*, where the real client address is known,
> and set `PAPERLESS_MCP_RATE_LIMIT_MAX` high enough that this limiter only acts as a
> backstop (or `0` to disable it, if the proxy's limiting is authoritative).

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

## License and attribution

This project is released under the [MIT License](LICENSE).

It is a hard fork of [`nloui/paperless-mcp`](https://github.com/nloui/paperless-mcp),
and parts of the tree are still derived from that work: 530 of the 3606 lines
under `src/` (15%), concentrated in `src/api/PaperlessAPI.ts` and the document,
tag, correspondent and document-type tool modules. Upstream ships no LICENSE
file anywhere — not in the repository, not in its npm tarball; its
`package.json` declares `"license": "ISC"` and `"author": "Nick Loui"`, and has
since its first commit.

[**NOTICE**](NOTICE) carries that attribution: which files are affected and by
how much, the ISC terms the upstream portions come under, and — read this part
before relying on it — exactly which pieces of that notice had to be
reconstructed, because upstream never published one to quote. `NOTICE` is
listed in `files` in `package.json`, so it ships inside the npm package too.
Keeping it out of [LICENSE](LICENSE) is deliberate: a permissive fork states
its own grant in `LICENSE` and the inherited one alongside it, so that nothing
reads as though upstream licensed its work under MIT, and so that the MIT text
stays machine-detectable.

There are no upstream pull requests and no attempt to stay mergeable with
upstream; the two trees have diverged substantially.

## Releasing

See [RELEASING.md](RELEASING.md). In short: bump the version on `main`, then
create a GitHub release whose tag matches it, and
`.github/workflows/npm-publish.yml` runs the quality gate and publishes to npm.
