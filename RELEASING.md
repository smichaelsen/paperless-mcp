# Releasing

`@smic/paperless-mcp` is published to the public npm registry by
`.github/workflows/npm-publish.yml`, which runs **only** when a GitHub release is
**published**. Pushing a tag on its own publishes nothing; neither does a push to
`main`; neither does saving a release as a draft. Publishing the release is the
single deliberate act that publishes the package.

> The workflow listens for `release: [published]` rather than `[created]` on
> purpose. `created` does not fire when a release that was saved as a draft is
> later published — the normal flow, and the GitHub UI's default — so a
> `created` trigger would have produced no run at all, and no failure either.
> `published` fires on both paths.

## One-time setup

The workflow authenticates with **Trusted Publishing (OIDC)**. There is no npm
token in this repository's secrets doing the work: the job asks GitHub for a
short-lived OIDC token and exchanges it with npm for a publish token that lives
only for the length of that publish. That matters here because the npm account
has no 2FA — npm currently offers hardware-key 2FA only — so a stored publish
token would be most of what stands between an attacker and every installer.

Setup is one form on npmjs.com, and the workflow cannot do it for you.

1. **Register the trusted publisher.** Sign in to npmjs.com as an account that
   may publish under the `@smic` scope, then go to
   *Packages → `@smic/paperless-mcp` → Settings → Trusted publisher*, pick
   **GitHub Actions**, and fill in:

   | Field | Value |
   | --- | --- |
   | Organization or user | `smichaelsen` |
   | Repository | `paperless-mcp` |
   | Workflow filename | `npm-publish.yml` |
   | Environment name | *leave empty* |

   **Every field is matched exactly and case-sensitively.** The workflow
   filename is just the filename — not `.github/workflows/npm-publish.yml` —
   and it must carry the `.yml` extension, spelled the way the file is spelled.
   Renaming or moving `.github/workflows/npm-publish.yml` silently revokes its
   ability to publish until this form is updated to match.

   **Leave *Environment name* empty.** It is optional, and filling it in makes
   npm require the job to run inside a GitHub environment of exactly that name.
   The publish job declares no `environment:`, so a value here would reject
   every publish.

   The form lives under an existing package's settings, so a package has to
   have been published at least once before a trusted publisher can be
   registered for it. `@smic/paperless-mcp@0.1.0` was published with a token,
   which is why this could not be part of the first release.

2. **The scope must exist on npm** and the account must be a member of it.

3. That is all. `--access public` is already in the workflow: scoped packages
   default to a restricted publish, and without that flag the first publish of a
   scoped package fails with `E402 Payment Required` even though the package is
   meant to be free and public.

Constraints worth knowing: self-hosted runners are not supported (this repo uses
`ubuntu-latest`), and a package may have at most 10 trusted publishers.

### Fallback: publishing with a stored token

Keep this. It is the rollback if trusted publishing ever fails, and it is how
0.1.0 shipped. Restoring it means putting the token back into the publish job:
add `registry-url: https://registry.npmjs.org` to the `actions/setup-node` step,
and `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to the `Publish` step's `env:`.

The token itself is an **`NPM_TOKEN` repository secret**, for an account that may
publish under the `@smic` scope, added under *Settings → Secrets and variables →
Actions → New repository secret*, named exactly `NPM_TOKEN`. Never paste a token
into a file in this repository.

A **granular access token** needs **both** of these, and neither is the default:

- permission **Read and write (publish and stage)** — *not* "stage only", which
  cannot create a version at all; and
- **bypass 2FA enabled** — npm refuses an unattended publish otherwise.

Both were established the hard way on the 0.1.0 release, which took three
attempts. The failure modes are worth recognising, because the first one does not
say what it means:

| Token | Result |
| --- | --- |
| Stage only | `E404 Not Found - PUT .../@smic%2fpaperless-mcp` |
| Publish and stage, no bypass | `E403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.` |
| Publish and stage, bypass enabled | publishes |

**That `E404` is an authorization failure, not a missing package.** npm answers
404 rather than 403 on an unauthorized write so it does not leak whether a
package exists — so a token problem reads exactly like a typo in the package
name. If a publish 404s, suspect the token before the name.

A classic **automation** token also bypasses the 2FA prompt and works, but npm is
steering towards granular tokens.

**Do not revoke `NPM_TOKEN` until a release has published successfully through
trusted publishing.** Until then it is the only way back.

### Why the publish job pins Node 24, and has no `registry-url`

Two things in the publish job look arbitrary and are not.

**Node 24.** Trusted Publishing requires npm >= 11.5.1 and Node >= 22.14.0. Node
22 still ships npm 10.9.x (v22.23.2 → npm 10.9.8), so the job's previous
`node-version: 22` was below the floor; Node 24 ships npm 11.19.0, and every
24.x from 24.5.0 onward ships npm >= 11.5.1. The alternative — `npm install -g
npm@latest` on Node 22 — pulls an unpinned npm over the network on every
release, which is the kind of supply-chain surface this change exists to reduce.
A guard step checks `npm --version` against 11.5.1 and fails in seconds with a
sentence, so a future floor change cannot surprise a release at its last step.
The quality gate still tests **both** 22 and 24: that matrix is about the Node
versions users may run this server on, and is unrelated to publishing.

**No `registry-url`.** `actions/setup-node` (through v6) writes an `.npmrc`
containing `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`, points
`NPM_CONFIG_USERCONFIG` at it, and exports a **placeholder**
`NODE_AUTH_TOKEN=XXXXX-XXXXX-XXXXX-XXXXX` when the variable is unset. Deleting
the `NODE_AUTH_TOKEN:` line from the workflow therefore does *not* leave the job
tokenless — it leaves it holding a junk one. npm prefers OIDC, so publishes
still succeed, but a *failed* OIDC exchange falls through to the placeholder and
dies with an opaque registry `E401`/`E404` instead of "This command requires you
to be logged in". Omitting `registry-url` removes the `.npmrc` and the
placeholder both; npm defaults to `https://registry.npmjs.org/` regardless. If
you ever add `registry-url` back, add the token back with it.

## Cutting a release

1. Land everything you want in the release on `main`, green CI.
2. Bump `version` in `package.json` (and the lockfile — `npm version <x.y.z>
   --no-git-tag-version` does both), following semver. **Then bump
   `SERVER_VERSION` in `src/index.ts` to match**: it is advertised to every MCP
   client as `serverInfo.version` in the `initialize` response, and it cannot be
   read from `package.json` without moving the compiled entrypoint off
   `build/index.js`. `tests/serverInfo.test.ts` fails if the two disagree, so a
   miss costs a red run rather than a server that misreports itself. Commit both
   on `main`.
3. Create the GitHub release:

   ```bash
   gh release create v1.1.0 \
     --repo smichaelsen/paperless-mcp \
     --title v1.1.0 \
     --generate-notes
   ```

   The tag **must** match the version in `package.json`, with or without a
   leading `v`. The workflow compares the two and fails the publish if they
   disagree, so a mismatch costs you a red run rather than a wrong version on
   npm. `gh release create` creates the tag if it does not exist yet.

   If you draft the release in the UI instead, nothing happens until you press
   **Publish release** — that is the event the workflow waits for. Add
   `--prerelease` (or tick the box) for a release candidate: the workflow then
   publishes it under the npm dist-tag `next` instead of `latest`, so a plain
   `npm install` keeps resolving to the last stable version.

   > **The first release must not be a pre-release.** A pre-release publishes
   > to `next` and leaves the package with no `latest` dist-tag at all, so
   > `npm install -g @smic/paperless-mcp` and the `npx` snippets — both
   > documented in the README — would resolve to nothing. That is the very
   > defect this whole process exists to fix. Pre-releases are only safe once a
   > `latest` exists for them to sit beside.
4. Watch the run: `gh run watch --repo smichaelsen/paperless-mcp`. It
   type-checks, runs the unit tests, builds, verifies the bin shebang survived
   the build and audits production dependencies — on Node 22 and 24 — before it
   publishes anything.
5. Verify: `npm view @smic/paperless-mcp version`.

> **The first release after switching to trusted publishing is the experiment.**
> There is no way to rehearse the OIDC exchange without publishing. Cut it as a
> patch version so a failure costs one burnt version number, and check the run
> log for `Successfully retrieved and set token` under the publish step. If it
> fails, the recovery is the [token fallback](#fallback-publishing-with-a-stored-token):
> restore `registry-url` and `NODE_AUTH_TOKEN`, bump to the next patch, and cut
> another release — a version number that failed to publish cannot be reused.
> Only once a release has gone out through trusted publishing should `NPM_TOKEN`
> be revoked on npm and deleted from the repository secrets.

## What gets published

`files` in `package.json` is `["build", "NOTICE"]`, so the tarball is the
compiled JavaScript, the upstream attribution, and `package.json`, `README.md`
and `LICENSE` — those three npm always includes, whatever `files` says. `src/`,
`tests/`, the Dockerfile and the Compose examples stay out.

**`NOTICE` has to be listed explicitly.** npm's always-included set is
`package.json`, `README` and `LICENSE` and nothing else — a `NOTICE` or
`THIRD-PARTY-NOTICES.md` is dropped unless `files` names it. Removing it from
`files` would ship an MIT-licensed package carrying none of the upstream ISC
attribution that `NOTICE` exists to carry. If you ever touch that field, run
`npm pack --dry-run` and confirm `NOTICE` is still in the listing.

Inspect it before releasing, without publishing anything:

```bash
npm run build
npm pack --dry-run
```

`build/index.js` must appear in the listing and must keep its
`#!/usr/bin/env node` first line — it is the `paperless-mcp` bin, and without
the shebang the installed command is not runnable. The executable **bit** is not
something to look for in the tarball: npm normalises every entry to `0644` when
packing and sets `0755` on bin targets at install time. Verified by installing
the tarball into a throwaway prefix:

```bash
npm pack --pack-destination /tmp
npm i -g --prefix /tmp/pm-check /tmp/smic-paperless-mcp-*.tgz
ls -l /tmp/pm-check/lib/node_modules/@smic/paperless-mcp/build/index.js  # -rwxr-xr-x
/tmp/pm-check/bin/paperless-mcp                                                # prints usage
```

## Provenance

The workflow publishes with `--provenance`, which uses the job's OIDC token
(`id-token: write`) to attest that the tarball was built by this workflow from
this commit. npm shows the resulting badge on the package page and anyone can
verify it. It requires a public repository — this one is — and costs nothing.

Trusted publishing enables provenance by default, so the flag is documented as
unnecessary. It is kept anyway, on purpose: npm's auto-enable sits inside a
`try/catch` that swallows every error and logs it at verbose level only, so
without the flag a failure to enable provenance would be invisible — the release
would publish, and the attestation would simply not be there. 0.1.0 has one;
0.1.1 losing it quietly would be a regression nobody would notice. With the flag,
a provenance failure fails the publish.

If a publish ever fails inside provenance generation specifically, dropping the
flag is a safe fallback; dropping `--access public` is not.

## Container images

Separate path, separate workflow: `.github/workflows/docker-publish.yml` pushes
`ghcr.io/smichaelsen/paperless-mcp:latest` (and `:main`) on **every push to
`main`**, not on release. A release does not currently produce a version-tagged
image.
