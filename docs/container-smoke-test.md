# Container smoke test

A maintainer runbook: the check the hardened Compose example is expected to
pass. See [Container deployment](../README.md#container-deployment) in the
README for what it is testing.

It runs as written from a clean checkout. It needs no real Paperless instance
and no published image: [`compose.smoke.yaml`](../compose.smoke.yaml) builds the
image from the checkout and swaps in a stub upstream, changing nothing about the
hardening in [`compose.example.yaml`](../compose.example.yaml) — which is the
point, since a smoke test that relaxes what it is testing proves nothing. The
stub also makes the *outage* case producible on demand, by stopping one
container.

Run it from the repository root, not from `docs/`.

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
deleted, because an earlier version of the Dockerfile removed npm, npx and
corepack, probed for exactly those three, and shipped Yarn 1 regardless. The
image build
makes the same assertion itself — a `command -v` sweep across `$PATH` plus an
exact listing of the three Node tooling directories — so a base image that
reintroduces a package manager fails the build rather than this step.

Step 9's `sleep 11` is not padding. `/readyz` caches a successful verdict for
ten seconds, so for the first ten seconds after the upstream stops it still
answers `200` — correctly. Skipping the wait makes a working readiness check
look broken.

Step 10 is the amplification guard: the counter moves by exactly one across
thirty concurrent unauthenticated requests.
