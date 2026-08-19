# Release process

Releases use [release-please](https://github.com/googleapis/release-please). Conventional Commits select the next version and generate the release PR, changelog entry, Git tag, and GitHub Release.

`package.json` is the version source of truth. Each release PR also updates `herdr-plugin.toml` and `.release-please-manifest.json` to the same version.

## One-time repository setup

Create a fine-grained personal access token with `contents:write` and `pull-requests:write` access to this repository. Save it as the Actions secret `RELEASE_PLEASE_TOKEN`.

A personal token is required so pull requests and tags created by release-please trigger the repository's other GitHub Actions workflows. The default `GITHUB_TOKEN` suppresses those follow-on workflow runs.

## Cut a release

1. Merge changes to `main` using Conventional Commits.
   - `fix:` selects a patch release.
   - `feat:` selects a minor release.
   - `feat!:` or a `BREAKING CHANGE:` footer selects a major release.
2. Wait for the `Release Please` workflow to open or update its release PR.
3. Check that CI passes and review the generated version and `CHANGELOG.md` entry.
4. Merge the release PR.
5. The next `Release Please` run creates `vX.Y.Z` and publishes the matching GitHub Release.

This plugin ships as source. There are no release assets to build or upload: Herdr checks out the selected ref and runs the Bun production install from `herdr-plugin.toml`.

Install a specific release with:

```sh
herdr plugin install iurysza/herdr-tab-smart-rename --ref vX.Y.Z
```

Do not create or force-push release tags by hand. Fix release problems on `main` and cut a new patch release.
