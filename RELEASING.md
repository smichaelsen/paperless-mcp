# Releasing

`@smichaelsen/paperless-mcp` is published to the public npm registry by
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

Nothing has ever been published, so the first release also needs this. Check it
before cutting one — the workflow cannot do it for you.

1. **`NPM_TOKEN` repository secret.** An npm **automation** token for an account
   that may publish under the `@smichaelsen` scope. Automation tokens bypass the
   2FA prompt, which is what makes an unattended publish possible; a
   publish-scoped granular access token works too. Add it under
   *Settings → Secrets and variables → Actions → New repository secret*, named
   exactly `NPM_TOKEN`.
   Never paste a token into a file in this repository.
2. **The scope must exist on npm** and the account must be a member of it.
3. That is all. `--access public` is already in the workflow: scoped packages
   default to a restricted publish, and without that flag the first publish of a
   scoped package fails with `E402 Payment Required` even though the package is
   meant to be free and public.

## Cutting a release

1. Land everything you want in the release on `main`, green CI.
2. Bump `version` in `package.json` (and the lockfile — `npm version <x.y.z>
   --no-git-tag-version` does both), following semver. Commit that on `main`.
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
   > `npm install -g @smichaelsen/paperless-mcp` and the `npx` snippets — both
   > documented in the README — would resolve to nothing. That is the very
   > defect this whole process exists to fix. Pre-releases are only safe once a
   > `latest` exists for them to sit beside.
4. Watch the run: `gh run watch --repo smichaelsen/paperless-mcp`. It
   type-checks, runs the unit tests, builds, verifies the bin shebang survived
   the build and audits production dependencies — on Node 22 and 24 — before it
   publishes anything.
5. Verify: `npm view @smichaelsen/paperless-mcp version`.
6. **After the first release only:** the Installation section of `README.md`
   opens with an admonition telling the reader to check whether the package
   exists on npm at all, because at the time of writing it did not. Once
   step 5 answers with a version, that check is noise — delete the admonition
   and leave the install commands. Nothing else in the README depends on the
   package being unpublished.

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
npm i -g --prefix /tmp/pm-check /tmp/smichaelsen-paperless-mcp-*.tgz
ls -l /tmp/pm-check/lib/node_modules/@smichaelsen/paperless-mcp/build/index.js  # -rwxr-xr-x
/tmp/pm-check/bin/paperless-mcp                                                # prints usage
```

## Provenance

The workflow publishes with `--provenance`, which uses the job's OIDC token
(`id-token: write`) to attest that the tarball was built by this workflow from
this commit. npm shows the resulting badge on the package page and anyone can
verify it. It requires a public repository — this one is — and costs nothing.
If a publish ever fails inside provenance generation specifically, dropping the
flag is a safe fallback; dropping `--access public` is not.

## Container images

Separate path, separate workflow: `.github/workflows/docker-publish.yml` pushes
`ghcr.io/smichaelsen/paperless-mcp:latest` (and `:main`) on **every push to
`main`**, not on release. A release does not currently produce a version-tagged
image.
