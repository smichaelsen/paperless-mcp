# Paperless-NGX MCP Server

An MCP (Model Context Protocol) server for a [Paperless-NGX](https://docs.paperless-ngx.com/)
instance. It gives an AI assistant tools to search, read, upload and organise
documents, tags, correspondents and document types.

Two things to know before wiring it up:

- **It starts read-only.** Everything that can change your Paperless instance is
  absent from `tools/list` until you opt in — see [Tool access modes](#tool-access-modes).
- **`--http` requires an authentication secret and binds loopback.** It refuses
  to start without a secret — see [Authentication](#authentication).

## Supported versions

| | Supported |
| --- | --- |
| Paperless-ngx | **2.16.0 – 3.1.x** (both ends exercised in CI against live instances) |
| Paperless-ngx REST API | version **9** |
| Node.js | 22 LTS and 24 LTS |

The client asks for REST API version 9 with an `Accept: application/json; version=9`
header. Version 9 arrived in Paperless-ngx 2.16.0 and is still accepted by 3.1.x;
instances at 2.15.x or older answer `406 Not Acceptable`. That becomes an explicit
error naming what to upgrade — the upstream response body is never read, logged or
forwarded into a tool result.

Both ends of that range are booted and tested on every pull request, not asserted
against a mock (see [Integration tests](#integration-tests-against-a-real-paperless-ngx)).
Measured there: 2.16.0 reports `X-Api-Version: 9` and refuses version 10; 3.1.3
reports `X-Api-Version: 10` and still serves version 9. Note that a `406` carries
neither `X-Api-Version` nor `X-Version` — Paperless fails content negotiation before
it stamps those headers — so the error can say that the version was refused but not
which version the instance would have offered.


## Quick Start

```bash
npm install -g @smic/paperless-mcp
```

Get an API token from Paperless-NGX: log in, click your username (top right) →
**My Profile** → the circular arrow button.

Then point your MCP client at it — for the Claude desktop app, edit
`~/Library/Application Support/Claude/claude_desktop_config.json`; for the Cline
VSCode extension, `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "paperless": {
      "command": "paperless-mcp",
      "env": {
        "PAPERLESS_URL": "http://your-paperless-instance:8000",
        "PAPERLESS_API_TOKEN": "<API_TOKEN>"
      }
    }
  }
}
```

The global install puts a single executable called `paperless-mcp` on your PATH.
Without one, use `"command": "npx"` with `"args": ["-y", "@smic/paperless-mcp"]`.

The base URL and token can also be passed positionally, which is what older
configurations do — `"args": ["-y", "@smic/paperless-mcp", "http://your-paperless-instance:8000", "<API_TOKEN>"]`.

> [!WARNING]
> A positional token is a process argument: it is visible in `ps` to every user on
> the host, in shell history, and in `docker inspect`. On anything shared, use the
> environment — or better, `PAPERLESS_API_TOKEN_FILE`. See [Configuration](#configuration).

That is it. You can now ask the assistant things like "show me all documents tagged
Invoice", "search for documents containing tax return", or — once writes are
enabled — "create a tag called Receipts with color #FF0000".

### From a Git checkout

What you want if you intend to change anything:

```bash
git clone https://github.com/smichaelsen/paperless-mcp.git
cd paperless-mcp
npm ci && npm run build
npm link          # puts `paperless-mcp` on your PATH, pointing at this checkout
```

Then use `"command": "paperless-mcp"` with no package name in `args`, or point
`command` at `<checkout>/build/index.js` with `node`.

## Configuration

The base URL and token come from positional arguments (`paperless-mcp <baseUrl> <token>`)
or from the environment. Environment variables are consulted only when the matching
argument is missing — a positional token always wins, and `PAPERLESS_API_TOKEN_FILE`
is not even read in that case. In `--http` mode the environment is the only source;
positional arguments are ignored.

| Variable | Purpose |
| --- | --- |
| `PAPERLESS_URL` | Base URL of your Paperless-NGX instance, e.g. `https://paperless.example`. |
| `PAPERLESS_API_TOKEN` | Paperless API token. |
| `PAPERLESS_API_TOKEN_FILE` | Path to a file containing the API token. Takes precedence over `PAPERLESS_API_TOKEN`. |
| `API_KEY` | **Deprecated** alias for `PAPERLESS_API_TOKEN`. Still honoured; logs a deprecation notice. |
| `PAPERLESS_ALLOW_WRITES` | Register the write-class tools. Off by default — see [Tool access modes](#tool-access-modes). |
| `PAPERLESS_ALLOW_DESTRUCTIVE` | Register the destructive-class tools. Off by default, never implied by `PAPERLESS_ALLOW_WRITES`. |
| `PAPERLESS_MCP_AUTH_TOKEN_FILE` | **`--http` only, required.** Path to a file containing the bearer secret clients must present. Takes precedence over `PAPERLESS_MCP_AUTH_TOKEN`. |
| `PAPERLESS_MCP_AUTH_TOKEN` | `--http` only. The bearer secret inline. Prefer the `_FILE` form. |
| `PAPERLESS_MCP_ALLOW_UNAUTHENTICATED` | `--http` only. Explicitly start **without** authentication. Refused unless the bind address is loopback. |
| `PAPERLESS_MCP_BIND_ADDRESS` | `--http` only. Interface the listener binds to. Default `127.0.0.1` — loopback only. |
| `PAPERLESS_MCP_ENABLE_LEGACY_SSE` | `--http` only. Register the deprecated `GET /sse` + `POST /messages` routes. Off by default. |
| `PAPERLESS_MCP_MAX_BODY` | `--http` only. Largest accepted JSON body, e.g. `10mb` (the default) or `512kb`. This is also the upload ceiling: `post_document` carries the file base64-encoded *inside* the JSON-RPC body, so `10mb` is about 7.5 MB of actual file. |
| `PAPERLESS_MCP_RATE_LIMIT_MAX` | `--http` only. Requests per window per client address. Default `600`; `0` disables rate limiting. Behind a reverse proxy every request shares the proxy's address, so the limit becomes one global bucket and one noisy client `429`s everyone — including a caller holding the correct secret. Rate-limit at the proxy instead and raise or disable this. |
| `PAPERLESS_MCP_RATE_LIMIT_WINDOW_MS` | `--http` only. Rate-limit window in milliseconds. Default `60000`. |
| `PAPERLESS_MCP_ALLOWED_HOSTS` | `--http` only. Comma-separated hostnames accepted in the `Host` header (ports ignored). **Replaces** the default `localhost,127.0.0.1,[::1]` rather than extending it. `*` disables the check. |
| `PAPERLESS_MCP_ALLOWED_ORIGINS` | `--http` only. Comma-separated origins accepted in the `Origin` header. Default: none — a request carrying *any* `Origin` is rejected, while requests without one (every non-browser MCP client) pass. `*` disables the check. |

**File-backed credentials.** `PAPERLESS_API_TOKEN_FILE` and
`PAPERLESS_MCP_AUTH_TOKEN_FILE` are the Docker/Kubernetes secrets form and the
recommended one: the file is read once at startup, surrounding whitespace
(including the trailing newline) is stripped, and an unreadable or empty file
aborts startup with a message that never contains the secret. A read-only mount is
enough. Neither is accepted as a `--flag`, on purpose: an argument is visible in
`ps`, in shell history and in `docker inspect`. The Paperless token does still have
the positional `paperless-mcp <baseUrl> <token>` form, with exactly that exposure;
the `--http` bearer secret has no command-line form at all. Generate one with
`openssl rand -base64 32 > paperless_mcp_auth.txt`.

[`compose.example.yaml`](compose.example.yaml) wires both files up as Docker
secrets — see [Container deployment](#container-deployment).

**Logging.** Operational events go to stderr as single-line JSON. A failed request
logs the HTTP method, a normalized endpoint class (`/documents/:id/`), the status,
the duration and an error class — nothing else:

```json
{"level":"error","event":"paperless_request_failed","method":"GET","endpoint":"/documents/:id/","status":500,"duration_ms":34,"error_class":"HttpStatusError"}
```

Tokens, authorization headers, request bodies, uploaded files, document
titles/content and raw Paperless responses are never logged.

## Tool access modes

Every tool belongs to exactly one access class:

- **read** — cannot change anything in Paperless.
- **write** — creates or updates objects. Never deletes one, never replaces a
  permission set.
- **destructive** — deletes documents, pages or objects, or replaces permissions.
  Effects that cannot be undone from this server.

The process starts **read-only**, and the two opt-ins are independent: enabling
writes does *not* enable destructive operations. Whatever is not enabled is **never
registered**, so it is absent from `tools/list` rather than advertised-and-refusing
— a model cannot ask for a tool it cannot see, and your client's allowlist has less
to cover.

| Mode | Start it with | Tools advertised |
| --- | --- | --- |
| **read-only** (default) | nothing to set | **9** |
| **write** | `PAPERLESS_ALLOW_WRITES=true` or `--allow-writes` | **16** |
| **destructive** | additionally `PAPERLESS_ALLOW_DESTRUCTIVE=true` or `--allow-destructive` | **20** |

The flags may appear anywhere on the command line; they are not mistaken for the
positional `<baseUrl> <token>`. Accepted true values are `1`, `true`, `yes`, `y`,
`on`, `enable`, `enabled` (case-insensitive); anything unrecognized is treated as
**off** and logged, because a typo must never widen what the server exposes.
`PAPERLESS_ALLOW_DESTRUCTIVE` on its own also enables writes — every destructive
operation is a write — and says so in the log. The active mode is logged once at
startup:

```json
{"level":"info","event":"tool_access_mode","mode":"write","writes":true,"destructive":false,"tools":16}
```

### `bulk_edit_documents`

The one tool whose destructiveness depends on an argument: the same `method` enum
spans setting a correspondent and permanently deleting documents. In write mode it is
therefore **narrowed** — `method` offers only
`set_correspondent`, `set_document_type`, `set_storage_path`, `add_tag`,
`remove_tag`, `modify_tags`, `reprocess`, `merge`, `split` and `rotate`, while
`delete`, `delete_pages` and `set_permissions` are neither advertised nor accepted by
the handler. The `delete_originals` and `permissions` arguments are gone from the
schema and `merge`/`split` are sent with an explicit `delete_originals: false`, so
they create a new document and leave the originals in place. `pages` stays because
Paperless requires it to `split`; on its own it does nothing, since the method that
would delete pages is not reachable. `PAPERLESS_ALLOW_DESTRUCTIVE` brings the full
enum and all arguments back.

Two of its arguments are reshaped before they go to Paperless, because the tool's
surface and the API's payload disagree. `set_permissions` takes its settings under a
single `permissions` argument (`set_permissions`, `owner`, `merge`), which the handler
flattens to the top level of the request — the API looks for `set_permissions` there,
and until this was fixed the method never worked on any supported version. And
`delete_pages` receives `pages` as the documented `1,3,5-7` string and sends it on as a
list of integers, which is the only form it accepts; `split` takes the same string and
is passed through untouched, because Paperless expands that one itself. Both shapes are
asserted against live 2.16.0 and 3.1.3 instances in the integration suite.

### Client allowlist and approval policy

Server-side gating decides what *exists*; the client's allowlist decides what runs
without asking. Run the narrowest mode each client needs rather than one permissive
server for everything: read-only for an assistant that answers questions about your
documents, `--allow-writes` for one that files and tags incoming mail,
`--allow-destructive` plus an allowlist of nothing for a cleanup session. Give the
server its own Paperless account with only the permissions it needs — the access mode
is a guard rail in this process; the Paperless permission model is the one an attacker
cannot argue with.

The read class is the only one worth auto-approving, and read-only is still not the
same as harmless: `search_documents` and `download_document` return the contents of
your documents, so a prompt injection hidden in a scanned document can use them to
find sensitive material and hand it to whatever *other* tool the assistant has for
sending data out (web requests, mail, shell). Ask every time for the write class —
`update_document` and `bulk_edit_documents` act on many documents at once, so see the
`documents` array first — and ask, and read the arguments, for the destructive class,
where nothing can be undone from this server. Keep destructive operations out of
unattended runs by starting those processes without `PAPERLESS_ALLOW_DESTRUCTIVE`, so
the tools are not there to be called.

## Available Tools

Full parameter lists and descriptions live in the MCP tool schemas, which your
client reads from `tools/list`. This is the map.

| Tool | Class | What it does |
| --- | --- | --- |
| `get_document` | read | Full metadata, content preview, tags, correspondent and type for one document. |
| `search_documents` | read | Full-text search. Returns metadata **without** the OCR content field. There is no `list_documents`: this enumerates too, via `page`/`page_size`. |
| `download_document` | read | The file as base64. `original: true` for the uploaded original instead of the archived version. |
| `post_document` | write | Upload a new document (base64 `file` + `filename`), optionally with title, `created` date, correspondent, type, storage path, tags, ASN, custom fields. |
| `update_document` | write | Correct title, `created` date, correspondent, type, storage path, tags or ASN on an existing document. **`tags` replaces the whole list** — use `bulk_edit_documents` with `add_tag`/`remove_tag` to change one. |
| `bulk_edit_documents` | write (narrowed) / destructive | Act on many documents at once; see [above](#bulk_edit_documents) for what write mode leaves out. |
| `list_tags` | read | Paginated, 25 per page (`page`, `page_size`). |
| `get_tag` | read | One tag by ID — resolves a name for an ID a document references. |
| `create_tag` | write | `name`, optional `color`, `match`, `matching_algorithm`. |
| `update_tag` | write | Change an existing tag's name, color or matching rules. |
| `delete_tag` | destructive | Removes the tag from every document that uses it. Cannot be undone. |
| `bulk_edit_tags` | destructive | `set_permissions` or `delete` across many tags. |
| `list_correspondents` | read | Paginated, like `list_tags`. |
| `get_correspondent` | read | One correspondent by ID. |
| `create_correspondent` | write | `name`, optional `match`, `matching_algorithm`. |
| `bulk_edit_correspondents` | destructive | `set_permissions` or `delete` across many correspondents. |
| `list_document_types` | read | Paginated, like `list_tags`. |
| `get_document_type` | read | One document type by ID. |
| `create_document_type` | write | `name`, optional `match`, `matching_algorithm`. |
| `bulk_edit_document_types` | destructive | `set_permissions` or `delete` across many document types. |

`matching_algorithm` takes **two different forms**, and they are not
interchangeable. `create_correspondent` and `create_document_type` take the string
enum `any` | `all` | `exact` | `regular expression` | `fuzzy`. `create_tag` and
`update_tag` take the equivalent **integer** instead: `0`=any, `1`=all, `2`=exact,
`3`=regular expression, `4`=fuzzy. Passing a string to a tag tool is a validation
error, and vice versa.

`readOnlyHint` is true for the read class only; `openWorldHint` is false throughout,
since every tool talks to exactly one configured instance. `destructiveHint` is true
for anything that overwrites rather than adds — including `update_document` and
`update_tag`, because `tags` replaces the whole list and the nullable relations clear
a field outright, and every `bulk_edit_*` object tool, because both of its operations
qualify: `delete` removes objects, and `set_permissions` with `merge: false` replaces
the permission set. `post_document`, `create_*` and `bulk_edit_documents` are not
idempotent; everything else is.

The server reports a clear error when the URL or token is wrong, when Paperless is
unreachable, when an operation fails, when parameters are invalid, and when the
instance does not support the requested REST API version (see
[Supported versions](#supported-versions)).

## Running the MCP Server

Both transports honour `--allow-writes` and `--allow-destructive` (and their
environment equivalents); without them the server is read-only.

### stdio (default)

How MCP clients such as Claude Desktop launch it, and what the
[Quick Start](#quick-start) configures.

```
paperless-mcp <baseUrl> <token>
npm run start -- <baseUrl> <token>    # from a checkout
```

### HTTP (Streamable HTTP transport)

`--http` serves MCP over HTTP, with `--port` (default `3000`). The URL and token
are read from the environment only. It **requires a bearer secret** and refuses to
start without one:

```
PAPERLESS_URL=http://localhost:8000 \
PAPERLESS_API_TOKEN_FILE=/run/secrets/paperless_token \
PAPERLESS_MCP_AUTH_TOKEN_FILE=/run/secrets/paperless_mcp_auth \
  paperless-mcp --http --port 3000
```

- The MCP API is at `POST /mcp`; `GET` and `DELETE /mcp` answer `405`.
- The listener binds `127.0.0.1` — **loopback only** — unless
  `PAPERLESS_MCP_BIND_ADDRESS` says otherwise.
- Every request must carry `Authorization: Bearer <secret>`.
- Requests are handled statelessly
  ([StreamableHTTPServerTransport](https://github.com/modelcontextprotocol/typescript-sdk)):
  no session id, no session table, and a fresh `McpServer` and transport per
  connection, so no mutable state is shared between clients.
- The deprecated `GET /sse` + `POST /messages` routes are **not registered** unless
  `PAPERLESS_MCP_ENABLE_LEGACY_SSE` is set.
- `GET /healthz` and `GET /readyz` answer container and load-balancer probes without
  credentials, and say nothing but a status code and one fixed field.

Middleware order is deliberate and security-relevant: Host/Origin check → rate limit
→ authentication → body parsing → transport. Rate limits, body-size limits, probe
caching and the reasoning behind all of it:
**[docs/http-transport.md](docs/http-transport.md)**.

#### Authentication

The HTTP listener hands out the whole enabled tool surface — and it holds a
Paperless API token — so every MCP transport route needs a shared bearer secret,
from `PAPERLESS_MCP_AUTH_TOKEN_FILE` (preferred) or `PAPERLESS_MCP_AUTH_TOKEN`.

```
curl -s http://127.0.0.1:3000/mcp \
  -H "Authorization: Bearer <SECRET>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'
```

Every failure mode answers the same `401`, the comparison is constant time, and the
secret never reaches a log line — see
[docs/http-transport.md](docs/http-transport.md) for that and the rest of the
hardening.

> [!IMPORTANT]
> `--http` exits with a message rather than starting unauthenticated. If you
> genuinely want an open listener — local development, nothing else on the machine —
> set `PAPERLESS_MCP_ALLOW_UNAUTHENTICATED=true`. It is refused in combination with a
> non-loopback `PAPERLESS_MCP_BIND_ADDRESS`.

#### Network exposure and TLS

The loopback default means nothing outside this host can reach the listener, and the
documented Compose deployment publishes no host port at all. Reaching it from
elsewhere is an explicit opt-in — `PAPERLESS_MCP_BIND_ADDRESS=0.0.0.0` — which logs
a `http_bind_not_loopback` warning at startup, because from that moment the port is
only as private as the network around it.

**This server speaks plain HTTP and does not terminate TLS.** Anything beyond
loopback — and certainly anything beyond a trusted private network — must go through
a reverse proxy (nginx, Caddy, Traefik) or a tunnel (Cloudflare Tunnel, Tailscale)
that terminates TLS and forwards to the listener. Without that, the bearer secret
crosses the wire in clear text on every request. If the proxy reaches the server
under a name other than a loopback one, add it to `PAPERLESS_MCP_ALLOWED_HOSTS`.

#### DNS-rebinding protection

Any web page can POST to `http://localhost:3000/mcp`, so the `Host` and `Origin`
headers are validated before a request reaches a transport: by default only loopback
*hostnames* are accepted and every browser origin is rejected. The host list
**replaces** the default rather than extending it, so keep the loopback names if you
still connect that way, and add any other name you reach the server under — a Docker
service name, a reverse proxy — otherwise those requests get a `403`:

```
PAPERLESS_MCP_ALLOWED_HOSTS=localhost,127.0.0.1,[::1],paperless-mcp
```

> [!NOTE]
> This is a header check, **not** an access control and **not** a network
> restriction: the `Host` header is written by the caller, so any host that can reach
> the port can send `Host: localhost` and pass it. What keeps the network out is the
> loopback default bind and bearer authentication. What this check contributes is the
> DNS-rebinding case specifically — a browser cannot be tricked into driving the
> server from a page on another origin.

The configuration in effect is printed at startup:

```json
{"level":"info","event":"http_server_listening","address":"127.0.0.1","port":3000,"transport":"streamable-http","session_mode":"stateless","auth":"bearer (PAPERLESS_MCP_AUTH_TOKEN_FILE)","legacy_sse":"disabled","max_body":"10mb","rate_limit":"600/60000ms","allowed_hosts":"localhost,127.0.0.1,[::1]","allowed_origins":"(none)"}
```

## Container deployment

`ghcr.io/smichaelsen/paperless-mcp:latest` is built and pushed on every push to
`main` (`.github/workflows/docker-publish.yml`). Two tags are published, `latest`
and the branch name `main`, pointing at the same digest; there is no version tag —
the image tracks `main`, not a release. If an anonymous `docker pull` is denied, the
GHCR package is still private: switch its visibility to public under *Packages →
paperless-mcp → Package settings*.

```
docker pull ghcr.io/smichaelsen/paperless-mcp:latest
# or build it yourself:
docker build -t paperless-mcp .

docker run --rm --init \
  -e PAPERLESS_URL=https://paperless.example \
  -e PAPERLESS_API_TOKEN=your-api-token \
  -p 127.0.0.1:3000:3000 \
  paperless-mcp
```

`--init` matters: PID 1 in this image is `node`, and the kernel applies no default
signal action to PID 1, so without an init `docker stop` waits out the full timeout
and then SIGKILLs. The Compose example sets `init: true`.

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

The pin is the digest of the multi-arch OCI *index*, so it still resolves on amd64
and arm64, rather than the tag alone: `node:24-bookworm-slim` names a different image
every few days, and a tag-only pin makes builds unreproducible. The tag is kept next
to the digest as documentation. Dependabot (`.github/dependabot.yml`) watches npm,
this Dockerfile and the Actions used by CI, which is what makes a digest pin
maintainable rather than a way to freeze in old Debian packages. npm, npx and corepack
are deleted from the final stage: a running MCP server never uses them, npm's own
dependency tree would show up in every image scan, and a process that manages to
execute in the container then has no package installer to hand.

### Hardened Compose example

[`compose.example.yaml`](compose.example.yaml) is the recommended deployment. Copy it
to `compose.yaml`, create the two secret files it documents, and adjust
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

Nothing is published to the host, so the server is not reachable from the LAN or the
internet by default. Other services on the Compose network reach it at
`http://paperless-mcp:3000/mcp`; anything beyond that network goes through a reverse
proxy or tunnel attached to the same network, which is also what terminates TLS.

Two settings in the file are load-bearing and easy to get wrong:

- `PAPERLESS_MCP_BIND_ADDRESS: "0.0.0.0"`. The listener binds loopback by default,
  which *inside a container* means "not reachable from the Compose network at all".
  The container network is the boundary here and the bearer secret is the access
  control.
- `PAPERLESS_MCP_ALLOWED_HOSTS` keeps the loopback names. That list **replaces** the
  default rather than extending it, and the image's `HEALTHCHECK` calls
  `http://127.0.0.1:3000/healthz` — drop `127.0.0.1` and every healthcheck becomes a
  `403`.

The tool access mode is read-only unless you say otherwise; the example has
`PAPERLESS_ALLOW_WRITES` and `PAPERLESS_ALLOW_DESTRUCTIVE` commented out so widening
the surface is a deliberate edit.

The image's `HEALTHCHECK` polls `GET /healthz`, which never touches Paperless — a
Paperless outage must not restart this container. `GET /readyz` is the one that
reports on the upstream (`503` when it is down), for a reverse proxy or load balancer
to poll. Both answer without credentials and say nothing beyond a status code; see
[docs/http-transport.md](docs/http-transport.md).

### Smoke test

The hardened example is expected to pass a full smoke test that runs from a clean
checkout against [`compose.smoke.yaml`](compose.smoke.yaml), needing no real
Paperless instance and no published image. It is a maintainer runbook rather than
something a user has to run:
**[docs/container-smoke-test.md](docs/container-smoke-test.md)**.

## Development and testing

```bash
git clone https://github.com/smichaelsen/paperless-mcp.git
cd paperless-mcp && npm ci
# change things under src/, then run the quality gate:
npm run typecheck   # tsc --noEmit
npm test            # vitest, unit tests only, no network
npm run build       # tsc -> build/index.js (the published bin)
npm run audit:prod  # npm audit --omit=dev --audit-level=high
npm run start -- http://localhost:8000 your-api-token
```

Those four checks are the CI quality gate (`.github/workflows/ci.yml`), run on every
pull request and on pushes to `main`, on Node.js 22 and 24. Unit tests mock `fetch`,
so the default run never talks to a Paperless instance. The server is built on the
official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
and [zod](https://github.com/colinhacks/zod), over the
[Paperless-NGX REST API](https://docs.paperless-ngx.com/api/).

### Integration tests against a real Paperless-ngx

The tests in `tests/integration/` run against a real Paperless-ngx instance and are
**opt-in**: without `PAPERLESS_TEST_URL` they skip themselves, so `npm test` on a
laptop stays hermetic. They only ever create their own fixtures, named
`mcp-it-<random>-…`, and delete them again in the cleanup hook, including on failure —
but point them at a **disposable** instance anyway, not your production archive.

Note that Paperless **soft-deletes documents**: the document fixtures move to the trash
rather than disappearing, and stay there until it is emptied. Tags, correspondents and
document types are deleted outright. The disposable stack below sidesteps this by
throwing the container away; a long-lived instance will collect them.

The easiest way to get one is the disposable stack this repository ships. It is the
same stack CI uses, so a green run locally and a green run in CI mean the same thing:

```bash
PAPERLESS_IT_VERSION=3.1.3 ./scripts/integration-stack.sh up
eval "$(./scripts/integration-stack.sh env)"   # PAPERLESS_TEST_URL / _TOKEN / _UPLOAD
./scripts/integration-stack.sh test            # npm run test:integration, guarded
./scripts/integration-stack.sh down
```

Use the `test` subcommand rather than `npm run test:integration` directly in anything
automated. The suite skips itself when `PAPERLESS_TEST_URL` is unset and vitest then
exits `0`, so a bare run can report success having executed nothing at all; `test`
refuses to finish green unless the URL is set **and** at least one test actually ran.

`up` boots Redis and Paperless-ngx (SQLite, no volumes — see
`compose.integration.yaml`), creates a superuser with a password it generates for that
run, waits for the API *and* the Celery worker to be genuinely ready, and writes the
credentials to the gitignored `.paperless-it.env`. It takes about half a minute once
the images are pulled, and fails with the container logs rather than hanging if
Paperless does not come up.

To run against an instance you already have, set the variables yourself:

```bash
PAPERLESS_TEST_URL=http://localhost:8000 \
PAPERLESS_TEST_TOKEN=your-api-token \
npm run test:integration
```

`PAPERLESS_TEST_TOKEN` is required once the URL is set. `PAPERLESS_TEST_UPLOAD=1`
additionally runs the upload/consume workflow, which needs a running consumer and
puts documents into the instance — which is why it stays off unless asked for.

`.github/workflows/integration.yml` runs this suite on every pull request and push to
`main` against both ends of the supported range (2.16.0 and 3.1.3), and weekly against
whatever the newest upstream release is by then. That weekly job is what notices a new
Paperless-ngx breaking this client; it is deliberately not a pull-request gate.

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
