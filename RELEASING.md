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
| New feature or capability | Minor: `0.5.0` |
| Breaking change to composition, props, config, CLI, JSON results, transcripts, manifests, or the skill contract | Minor: `0.5.0`, called out in the changelog |
| Release candidate or preview | Prerelease: `0.5.0-next.1`, published under the `next` dist-tag |

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
pnpm check
pnpm pack --dry-run --json
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
- Create a repository ruleset named `Protect release tags` that blocks deletion
  and updates for `refs/tags/v*`. `pnpm retag-release` looks it up by name and
  restores it after a recovery.
- Keep `main` green; the release workflow runs the full suite before publishing.

## Release checklist

1. Confirm `main` is green and the working tree is clean:

   ```sh
   gh run list --branch main --workflow CI --limit 1
   git status --short --branch
   ```

   A branch ahead of `origin/main` means the release includes unpushed commits;
   the push in step 7 carries them.

2. Choose the version and update all version locations:

   ```sh
   pnpm set-version 0.5.0
   pnpm set-version --check
   ```

3. Update `CHANGELOG.md`: add the new version section with today's date, list
   the changes, and add the comparison link. The tag is the source of truth for
   what shipped; start from the commits since the last one:

   ```sh
   git log --oneline $(git describe --tags --abbrev=0)..HEAD
   ```

4. Run the release checks locally:

   ```sh
   pnpm check
   pnpm pack --dry-run --json
   ```

   `pnpm check` runs the script syntax checks, lint, formatting, typechecks,
   and the full suite. The `--json` output lists the tarball contents; confirm
   it contains `dist/`, `docs/`, `examples/`, `skills/`, `README.md`,
   `CHANGELOG.md`, `GLOSSARY.md`, and the license.

5. Commit and tag locally:

   ```sh
   git add package.json src/version.ts skills/frameyard/SKILL.md CHANGELOG.md
   git commit -m "chore(release): v0.5.0"
   git tag -a v0.5.0 -m "frameyard v0.5.0"
   ```

6. Verify the release before pushing:

   ```sh
   pnpm verify-release
   ```

   It checks that the version locations agree, the tag is annotated and points
   at `HEAD`, `CHANGELOG.md` has a dated section and comparison link for the
   version, the branch is `main`, and the working tree is clean.

7. Push and watch the `Release` workflow:

   ```sh
   git push origin main --follow-tags
   gh run list --workflow Release --limit 1
   gh run watch <run-id> --compact --interval 30
   ```

   The workflow runs `node scripts/verify-release.mjs --ci`, which repeats the
   local metadata checks and also confirms the tag is reachable from
   `origin/main`. It then runs `pnpm check`, inspects the package, publishes
   with provenance, and creates the GitHub Release. CI and the release workflow
   share the same `pnpm check` command; add new checks to `package.json`, not
   to the workflow files. If the run fails, `gh run view <run-id> --log-failed`
   prints only the failed step.

8. Verify the published result:

   ```sh
   npm view frameyard@0.5.0 version dist.tarball dist.attestations
   npm view frameyard dist-tags
   ```

   Registry reads lag publishes: the package document is cached for up to five
   minutes (`cache-control: max-age=300`), so `npm view` can return a 404 and
   `registry.npmjs.org` can serve a stale document after the publish step
   succeeded. Check the publish timestamp in the workflow log, then poll rather
   than treating the 404 as a failed publish:

   ```sh
   for _ in $(seq 1 30); do
     npm view frameyard@0.5.0 version && break
     sleep 10
   done
   npm view frameyard time --json
   ```

   `registry.npmjs.com` has a separate cache and can serve the fresh document
   first. Confirm the GitHub Release is published, not a draft, and matches the
   prerelease state:

   ```sh
   gh release view v0.5.0 --json tagName,isPrerelease,isDraft,url,publishedAt
   ```

## Prereleases

Use a prerelease version such as `0.5.0-next.1`. The release workflow detects
the `-` in the version, publishes under the `next` dist-tag instead of
`latest`, and marks the GitHub Release as a prerelease. Promote it only after
validation:

```sh
npm dist-tag add frameyard@0.5.0 latest
```

## Failure handling

- **A release fails before publishing:** fix the problem on `main`, commit, and
  run `pnpm check`. Push the fix without re-pushing the old tag, then inspect the
  recovery plan and apply it:

  ```sh
  git push origin main
  pnpm retag-release 0.5.0 --dry-run
  pnpm retag-release 0.5.0 --yes
  ```

  Do not push with `--follow-tags` here; it re-sends the old tag and starts a
  release run from the wrong commit. The script refuses if the version is
  already on npm, the tag is not on `main`'s history, or a configured
  `Protect release tags` ruleset is not active. It replaces the tag and
  restores the ruleset. See
  [Recovering an unpublished tag](#recovering-an-unpublished-tag).
- **npm publish succeeded, GitHub Release failed:** create the release manually:

  ```sh
  gh release create v0.5.0 --generate-notes --verify-tag
  ```

  For a prerelease, add `--prerelease --latest=false`.

- **A bad version is already published:** do not overwrite it. Deprecate it and
  publish a patch:

  ```sh
  npm deprecate frameyard@0.5.0 "Superseded by 0.2.1"
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

## Recovering an unpublished tag

A tag can be replaced only while its version is unpublished. `pnpm retag-release`
moves the local annotated tag to `HEAD`, temporarily disables the
`Protect release tags` ruleset, deletes and re-pushes the remote tag, verifies
the pushed tag object and peeled commit, and restores the ruleset.

1. Confirm the version is unpublished:

   ```sh
   npm view frameyard@0.5.0 version
   ```

   It must fail with `E404`. If it prints a version, stop: never move a
   published tag.

2. Push the fix without the old tag:

   ```sh
   git push origin main
   ```

   Do not use `--follow-tags`; it re-sends the tag you are about to replace and
   starts a release run from the wrong commit.

3. Inspect the plan:

   ```sh
   pnpm retag-release 0.5.0 --dry-run
   ```

   The script fetches `origin/main` and requires `HEAD` to be on it. It also
   requires `main`, a clean tree, `package.json` at the same version, `gh` admin
   access, and an active `Protect release tags` ruleset when one exists. An
   existing local or remote tag must point to a commit that is an ancestor of
   `HEAD`; the script replaces lightweight local tags and creates or moves the
   local annotated tag to `HEAD`.

4. Apply the plan:

   ```sh
   pnpm retag-release 0.5.0 --yes
   ```

5. Watch the new run:

   ```sh
   gh run list --workflow Release --limit 1
   gh run watch <run-id> --compact --interval 30
   ```

If the process is interrupted while the ruleset is disabled, open the
repository ruleset settings and set `Protect release tags` back to `Active`.
The script restores it in a `finally` block for normal failures.

## Why `pnpm publish`

The repository is pnpm-managed: CI and the release workflow use pnpm, and the
`prepublishOnly` guard blocks `npm publish`. `pnpm publish` runs the
repository's lifecycle scripts and supports provenance and trusted publishing.
In CI the tag checkout is a detached HEAD, so the workflow passes
`--no-git-checks` after verifying the tag and version explicitly.
