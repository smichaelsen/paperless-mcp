# syntax=docker/dockerfile:1

# Node.js 24 — the active LTS line. Node 20 went end-of-life in April 2026, so
# the previous `node:20-slim` base had stopped receiving security fixes
# entirely. CI runs the test suite on both 22 and 24 (.github/workflows/ci.yml),
# so 24 is a line this package is actually verified on.
#
# Pinned by **digest**, not by tag. `node:24-bookworm-slim` is a moving target:
# the same tag names a different image every few days, so a tag-only pin makes
# builds unreproducible and makes "what is in production" unanswerable. The
# digest below is the multi-arch OCI *index*, so it still resolves correctly on
# amd64 and arm64 — pinning a single platform manifest would break one of them.
# The tag is kept alongside the digest purely as documentation of what it is;
# Docker ignores it and uses the digest. Dependabot (.github/dependabot.yml)
# watches this line and opens a PR when the digest moves, which is the only
# reason a digest pin is maintainable at all.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

# ---------------------------------------------------------------------------
# Production dependencies only. Separate from the build stage so that the
# runtime image can copy a `node_modules` that has never contained typescript,
# vitest or ts-node.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `--ignore-scripts`: an install script runs arbitrary code from a transitive
# dependency at build time. None of the three runtime dependencies needs one.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---------------------------------------------------------------------------
# Compile. Nothing from this stage reaches the runtime image except `build/`.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
# Only the inputs `tsc` actually needs. Copying the whole context here would
# put the git history and the test suite into a build layer for no reason.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime: no compiler, no dev dependencies, no package manager, not root.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# Strip the package managers. A running MCP server never uses one, npm drags in
# a large dependency tree of its own that shows up in every image scan, and —
# the part that actually matters — a Node package manager runs happily as an
# unprivileged user and installs into any writable directory. With `/tmp` a
# writable tmpfs, code execution inside this container would otherwise be one
# `yarn add --cwd /tmp` away from fetching a second stage; `noexec` stops
# `execve`, not `require()` of a downloaded `.js`.
#
# `node:24-bookworm-slim` ships **Yarn 1 under /opt** as well as npm, which an
# earlier version of this file missed. Hence the assertions below, which pin
# what is *left* rather than what was removed. There are two, because either
# one alone claims more than it checks:
#
#  - a `command -v` sweep over every package manager name we know of, across
#    the whole `$PATH` — this catches a tool that arrives anywhere, including
#    directories this file never mentions, but only if we named it;
#  - an exact listing of the three directories the base image actually uses for
#    Node tooling (`/usr/local/bin`, `/opt`, `/usr/local/lib/node_modules`) —
#    this catches a tool we did *not* think to name, but only if it lands
#    there.
#
# Together they mean a future base image digest has to both invent a new name
# and put it somewhere new to get past the build.
#
# apt and dpkg remain, and are deliberately not removed: unlike yarn they need
# root *and* a writable root filesystem, and the documented deployment grants
# neither (`user: "1000:1000"`, `read_only: true`, `cap_drop: ALL`).
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /usr/local/bin/yarn \
           /usr/local/bin/yarnpkg \
           /opt/yarn-v* \
           /usr/local/bin/docker-entrypoint.sh \
    && for pm in npm npx corepack yarn yarnpkg pnpm pnpx pnpm-store bun bunx deno volta fnm nvm; do \
         if command -v "$pm" > /dev/null 2>&1; then \
           echo "package manager still on PATH: $pm -> $(command -v "$pm")"; \
           exit 1; \
         fi; \
       done \
    && printf 'node\nnodejs\n' > /tmp/expected \
    && ls -1 /usr/local/bin > /tmp/remaining \
    && { diff /tmp/expected /tmp/remaining \
         || { echo "unexpected executables left in /usr/local/bin"; exit 1; }; } \
    && [ -z "$(ls -A /opt)" ] \
    && [ -z "$(ls -A /usr/local/lib/node_modules)" ] \
    && rm -f /tmp/expected /tmp/remaining

ENV NODE_ENV=production
WORKDIR /app

# Everything stays owned by root and is only readable by the unprivileged user
# below: the application has no reason to be able to rewrite its own code, and
# the Compose example mounts the root filesystem read-only on top of that.
COPY --from=deps  --chown=root:root /app/node_modules ./node_modules
COPY --from=builder --chown=root:root /app/build ./
COPY --chown=root:root package.json ./package.json

# `node` (uid 1000) ships with the base image. Declared here so the image is
# non-root even when it is run without the Compose file's `user:` line.
USER node

# Documentation only — the Compose example publishes no host port at all and
# reaches the server over the Compose network.
EXPOSE 3000

# Liveness, deliberately: `/readyz` would report a Paperless outage as an
# unhealthy *container*, and an orchestrator would then restart a process that
# is working perfectly. Readiness is for a proxy or load balancer to poll.
#
# `node -e` rather than curl or wget: neither is installed, and adding one would
# put a network client into the runtime image purely for the healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

LABEL org.opencontainers.image.title="paperless-mcp" \
      org.opencontainers.image.description="MCP server for Paperless-ngx" \
      org.opencontainers.image.source="https://github.com/smichaelsen/paperless-mcp" \
      org.opencontainers.image.licenses="MIT"

# Exec form, so node is the process that receives signals rather than a shell.
# Node as PID 1 still ignores SIGTERM (the kernel applies no default action to
# PID 1), so run this with an init: `init: true` in the Compose example, or
# `docker run --init`. Without one, `docker stop` waits for the timeout and
# then SIGKILLs.
ENTRYPOINT ["node", "index.js", "--http", "--port", "3000"]
