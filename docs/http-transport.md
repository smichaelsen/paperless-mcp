# `--http` hardening reference

Why the HTTP transport behaves the way it does. The settings themselves — every
variable and its default — are in the
[Configuration table](../README.md#configuration); how to start the listener is in
[Running the MCP Server](../README.md#running-the-mcp-server).

Middleware order is the security-relevant part, and it is deliberate:

1. **Host/Origin** — the cheapest check, and the one that stops a browser page from
   reaching any of the following at all.
2. **Rate limit** — before authentication, so the bearer secret cannot be guessed at
   line rate.
3. **Authentication** — before the body parser, so an unauthenticated caller can
   never make this process buffer and parse a 10 MB body.
4. **Body parsing**, and only then a transport.

## Authentication

- A missing, malformed (`Basic` instead of `Bearer`, `Bearer` with nothing after it,
  no scheme at all) or simply wrong credential all get the **same** `401`, the same
  body and the same `WWW-Authenticate: Bearer` header. Telling "malformed" from
  "wrong" would tell a prober which half of its guess to fix.
- The comparison is constant time: `crypto.timingSafeEqual` over SHA-256 digests, so
  a length mismatch neither throws nor leaks the secret's length.
- A **duplicated** `Authorization` header is not rejected. Node keeps the first copy
  and discards the rest, so the first one is what gets authenticated. Worth knowing,
  because it is easy to assume otherwise; not a weakness, since supplying a correct
  value in either position already requires the secret.
- The secret is registered with the log redactor. It — and the `Authorization`
  header — never appear in a log line.
- A secret shorter than 16 characters starts the server but logs a warning: at the
  rate limiter's ceiling, anything shorter is guessable.

## Rate and body-size limits

| | Default | Variable |
| --- | --- | --- |
| Max JSON body | `10mb` | `PAPERLESS_MCP_MAX_BODY` |
| Requests per window | `600` | `PAPERLESS_MCP_RATE_LIMIT_MAX` (`0` disables) |
| Window | `60000` ms | `PAPERLESS_MCP_RATE_LIMIT_WINDOW_MS` |

The body limit is deliberately generous: `post_document` carries the uploaded file
**base64-encoded inside the JSON-RPC body**, so Express's own 100 kB default capped
every upload at roughly 74 kB of actual file. `10mb` is about 7.5 MB of file. A
read-only deployment — the default access mode — never needs more than a few
kilobytes and can turn it right down.

Over-limit bodies get `413`, unparseable ones `400`, and too many requests `429` with
a `Retry-After` header — all as JSON-RPC error objects rather than Express's HTML
error page.

Rate limiting keys on the client's TCP source address. `X-Forwarded-For` is
deliberately **not** honoured: it is a plain request header, so trusting it would let
any caller pick its own bucket. The tracked-address table is bounded (10,000
entries); past that, expired windows are swept and then the oldest live entry is
evicted to make room, so an unauthenticated caller cycling source addresses cannot
grow it without limit. Eviction resets the evicted client's counter; it never locks
anyone out.

> [!NOTE]
> **The rate limiter runs before authentication, and that is a deliberate
> trade-off.** It has to: checking the credential first would make every guess cheap
> and turn authentication itself into the thing being brute-forced. The cost is that
> a caller who exhausts the window from a given source address also locks out anyone
> else on that address — including a client holding the **correct** secret, which
> gets `429` rather than `200`.
>
> On a loopback or per-client-address deployment that is barely reachable. **Behind a
> reverse proxy it matters a great deal**: every request shares the proxy's address,
> so one noisy or hostile client consumes the whole window for everyone and the limit
> is effectively global. If you deploy behind a proxy, do the rate limiting *there*,
> where the real client address is known, and set `PAPERLESS_MCP_RATE_LIMIT_MAX` high
> enough that this limiter only acts as a backstop (or `0` to disable it, if the
> proxy's limiting is authoritative).

## Client isolation

Every connection gets its own `McpServer` and its own transport; no mutable server,
transport or session state is shared between clients. For Streamable HTTP a
connection is a single request — the mode is stateless, so no `Mcp-Session-Id` is
issued and there is no session table to leak or expire. The legacy `GET /sse` route
keeps one server per event stream, closed with the stream.

## Health and readiness

| Endpoint | Question | Success | Failure |
| --- | --- | --- | --- |
| `GET /healthz` | Is this process able to serve a request? | `200 {"status":"ok"}` | — |
| `GET /readyz` | Is Paperless reachable and answering this server? | `200 {"status":"ok"}` | `503 {"status":"unavailable"}` |

They answer two different questions on purpose. `/healthz` never touches Paperless:
the only sensible reaction to it failing is a restart, and restarting the MCP server
because *Paperless* is down turns one outage into a crash loop. So the container
`HEALTHCHECK` polls `/healthz`, while `/readyz` is what a reverse proxy or load
balancer should poll to stop routing traffic during an upstream outage. A Paperless
outage therefore leaves the container `healthy` and `/readyz` at `503`.

**They are reachable without credentials** — a Docker `HEALTHCHECK` or a Kubernetes
probe cannot present a bearer token — so they say as little as it is possible to say:
a status code and one fixed field. No version, no Paperless URL, no configuration, no
upstream status code, no error text.

Being exempt from authentication does not put them outside the rest of the boundary.
They are registered after the app-wide middleware, so the `Host`/`Origin` check and
the rate limiter apply to them exactly as they do to `/mcp`. The exemption covers
only `GET` and `HEAD`, and only for a request carrying no body: everything else on
those paths is authenticated like any other route, so an unauthenticated caller can
never make this process buffer a body.

**`/readyz` caches its verdict**, for 10 s on success and 2 s on failure, and
concurrent requests share a single in-flight probe. Without that, an unauthenticated
endpoint would be an amplifier: one cheap request here would mean one authenticated
request to Paperless, and anyone who could reach the port could use this server to
hammer it. The shorter failure TTL is so that a recovering Paperless is picked up
quickly. The upstream check itself is the cheapest authenticated call there is — the
API root — with a 5 s deadline, and its result is reduced to a single bit before it
reaches the response.
