# Releasing Frameyard

Frameyard releases are cut from a `vX.Y.Z` tag on `main`. CI runs the full
suite on the tag, publishes to npm with provenance, and creates the GitHub
Release only after the npm publish succeeds.

## Version policy

Frameyard stays on `0.x` until its public contracts stabilize. See
[`docs/v0.1-design.md`](./docs/v0.1-design.md) §13.

| Change | Version |
| --- | --- |
| Bug fix, documentation, internal refactor | Patch: `0.1.1` |
| New feature or capability | Minor: `0.2.0` |
| Breaking change to composition, props, config, CLI, JSON results, transcripts, manifests, or the skill contract | Minor: `0.2.0`, called out in the changelog |
| Release candidate or preview | Prerelease: `0.2.0-next.1`, published under the `next` dist-tag |

- Never move or reuse a published version.
- The annotated tag must be exactly `v` plus the `package.json` version.
- Every release updates [`CHANGELOG.md`](./CHANGELOG.md). Add a dated version
  section and record contract changes explicitly.
- The npm package, `src/version.ts`, and `skills/frameyard/SKILL.md` must all report the
  same version. `pnpm set-version` and `pnpm set-version --check` enforce this.

## One-time setup

### 1. Bootstrap the first publish

Trusted publishing can be configured only after the package exists on npm. The
first publish is therefore manual:

```sh
cd "$(git rev-parse --show-toplevel)"
npm login
pnpm lint
pnpm format:check
pnpm typecheck
pnpm typecheck:test
pnpm test
pnpm pack --dry-run
test "$(git branch --show-current)" = "main" || { echo "publish from main"; exit 1; }
test -z "$(git status --porcelain)" || { echo "working tree is dirty"; exit 1; }
pnpm publish --no-git-checks --access public
```

`npm login`, `npm view`, and `npx` work from the repository. `npm publish` is
gated by `scripts/check-package-manager.mjs`; use `pnpm publish`.

`pnpm publish --no-git-checks` skips pnpm's branch and dirty-tree checks. The
two `test` lines above replace them for the first publish; commit before
publishing.

### 2. Configure npm trusted publishing

On npmjs.com, open the `frameyard` package settings and add a trusted publisher:

- Publisher: GitHub Actions
- Repository: `vladiantio/frameyard`
- Workflow: `release.yml`
- Environment: `npm`

No `NPM_TOKEN` secret is needed after this. The release workflow requests an
OIDC token with `id-token: write` and publishes with provenance.

### 3. Protections

- Create a GitHub environment named `npm`. Restrict deployments to tags
  matching `v*`, and add required reviewers if releases should not start
  automatically.
- Protect `v*` tags from deletion and modification.
- Keep `main` green; the release workflow runs the full suite before publishing.

## Release checklist

1. Confirm `main` is green and the working tree is clean.

2. Choose the version and update all version locations:

   ```sh
   pnpm set-version 0.2.0
   pnpm set-version --check
   ```

3. Update `CHANGELOG.md`: add the new version section with today's date, list
   the changes, and add the comparison link.

4. Run the release checks locally:

   ```sh
   pnpm lint
   pnpm format:check
   pnpm typecheck
   pnpm typecheck:test
   pnpm test
   pnpm pack --dry-run
   ```

   Confirm the tarball contains `dist/`, `docs/`, `examples/`, `skills/`,
   `README.md`, `CHANGELOG.md`, `GLOSSARY.md`, and the license.

5. Commit and tag:

   ```sh
   git add package.json src/version.ts skills/frameyard/SKILL.md CHANGELOG.md
   git commit -m "chore(release): v0.2.0"
   git tag -a v0.2.0 -m "frameyard v0.2.0"
   git push origin main --follow-tags
   ```

6. Watch the `Release` workflow. It verifies the tag against `package.json`,
   that the tag is reachable from `main`, and that `CHANGELOG.md` has a dated
   section for the version. It then runs lint, formatting checks, typechecks,
   and the full suite, inspects the package, publishes with provenance, and
   creates the GitHub Release. The release job repeats the CI setup; when you
   change the checks in `ci.yml`, update `release.yml` too.

7. Verify the published result:

   ```sh
   npm view frameyard@0.2.0 version dist.tarball
   npm view frameyard dist-tags
   ```

   Confirm the GitHub Release exists and the npm page shows provenance.

## Prereleases

Use a prerelease version such as `0.2.0-next.1`. The release workflow detects
the `-` in the version, publishes under the `next` dist-tag instead of
`latest`, and marks the GitHub Release as a prerelease. Promote it only after
validation:

```sh
npm dist-tag add frameyard@0.2.0 latest
```

## Failure handling

- **Tests fail before publishing:** fix the problem, delete the tag locally and
  remotely, and cut a new tag only if the version was never published.
- **npm publish succeeded, GitHub Release failed:** create the release manually:

  ```sh
  gh release create v0.2.0 --generate-notes --verify-tag
  ```

  For a prerelease, add `--prerelease --latest=false`.

- **A bad version is already published:** do not overwrite it. Deprecate it and
  publish a patch:

  ```sh
  npm deprecate frameyard@0.2.0 "Superseded by 0.2.1"
  ```

  Move the `latest` dist-tag if a previous version should remain current:

  ```sh
  npm dist-tag add frameyard@0.1.0 latest
  ```

  Unpublishing is a last resort within npm's 72-hour window; prefer deprecation.

- **Provenance or authentication fails:** confirm the workflow filename,
  repository, and environment match the trusted publisher configuration, and
  that the job has `id-token: write`. Do not add a long-lived npm token unless
  trusted publishing is unavailable.

## Why `pnpm publish`

The repository is pnpm-managed: CI and the release workflow use pnpm, and the
`prepublishOnly` guard blocks `npm publish`. `pnpm publish` runs the
repository's lifecycle scripts and supports provenance and trusted publishing.
In CI the tag checkout is a detached HEAD, so the workflow passes
`--no-git-checks` after verifying the tag and version explicitly.
