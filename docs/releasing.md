# Releasing

How a new version reaches npm. The workflow builds and stages it, and only the maintainer can make it public, with two-factor authentication.

A release is tagged on a branch and merged into `main` only after npm has it. The plugin marketplaces and the README on `main` name an exact version, and `/plugin marketplace add` and `codex plugin marketplace add` read `main`, so `main` must never name a version that npm does not have.

## Before the first staged release

Two npm settings make the protections below true. Each command asks for two-factor authentication. Run them once, in a copy of the repository:

```bash
npm trust github little-snitch-mcp-server --file release.yml --repo Orhan-Said/little-snitch-mcp-server --env npm --allow-stage-publish
```

```bash
npm access set mfa=publish little-snitch-mcp-server
```

Check both:

- `npm trust list little-snitch-mcp-server` shows one GitHub publisher for `Orhan-Said/little-snitch-mcp-server`, workflow `release.yml`, environment `npm`, allowed to stage only.
- The package's access page on npmjs.com, under Publishing access, has "Require two-factor authentication and disallow tokens" selected. npm has no command that reads this setting back.

## Each release

1. On a branch, not on `main`, set the new version and add it to `CHANGELOG.md` with the date:

   ```bash
   npm version 0.2.1 --no-git-tag-version
   ```

   This writes the version into `package.json` and `package-lock.json`. Then `scripts/sync-version.mjs` writes it into both plugin manifests, both marketplaces, and the install commands in the README and the skill, stages those files and prints their names. A test fails when any of them names another version.

   Add `package.json`, `package-lock.json` and `CHANGELOG.md` to the same commit.

2. Push the branch, open a pull request into `main`, and wait until CI passes.
3. Tag the branch's last commit and push the tag. A tag cannot be moved or deleted afterwards, so tag only a commit whose CI passed.

   ```bash
   git tag -a v0.2.1 -m "0.2.1"
   git push origin refs/tags/v0.2.1
   ```

4. The Release workflow checks that the tag matches the version and that npm does not have that version yet. It then runs the packed-plugin check, the type-check, the tests and the build, and stages the version on npm. Its log ends with `+ little-snitch-mcp-server@0.2.1 (staged with id <id>)`. Nothing is public yet.
5. Look at what was staged:

   ```bash
   npm stage list little-snitch-mcp-server
   npm stage view <id>
   npm stage download <id>
   ```

   `download` saves the tarball in the current folder. `tar -tzf <file>` lists what is in it: the plugin manifests, `skills/`, `dist/` and the bundled `node_modules/`.
6. Approve it. npm asks for two-factor authentication.

   ```bash
   npm stage approve <id>
   ```

   If something is wrong, `npm stage reject <id>` deletes the staged version. The tag cannot move, so release the fix as the next version from the same branch.
7. Check the release from the registry: `npm view little-snitch-mcp-server@0.2.1`, and `npm audit signatures` in a project that installs it, which also checks the provenance statement.
8. Before merging, install the plugin from the branch in both clients. This is the first install through each client's own npm route.

   Claude Code:

   ```text
   /plugin marketplace add Orhan-Said/little-snitch-mcp-server#<branch>
   /plugin install little-snitch@little-snitch
   ```

   Codex:

   ```bash
   codex plugin marketplace add Orhan-Said/little-snitch-mcp-server --ref <branch>
   codex plugin add little-snitch@little-snitch
   ```

   In a new session of each, `/mcp` must show the server connected, and asking for the Little Snitch status must call `get_status`. If either fails, do not merge. Fix it on the branch and release the next version, since a published version cannot be replaced.
9. Merge the pull request with a merge commit or a fast-forward, not a squash, so the tagged commit stays in `main`'s history. Only now do `main`'s marketplaces and README name the new version.
10. Create the GitHub release from the changelog entry:

    ```bash
    gh release create v0.2.1 --verify-tag --title "0.2.1" --notes-file <file with the changelog entry>
    ```

## What protects a release

- npm trusts one publisher for the package: GitHub Actions, repository `Orhan-Said/little-snitch-mcp-server`, workflow `release.yml`, environment `npm`, allowed to stage and not to publish. This holds once the first setting above is made.
- The package's access setting on npm requires two-factor authentication for every publish and refuses tokens. This holds once the second setting above is made.
- The `npm` environment on GitHub accepts only `v*` tags, and tags cannot be moved or deleted.
- The workflow uses only GitHub's own actions, each pinned to a commit, and no cache. It fails when npm already has the version, so it never reports success for a package it did not build.
- `main` names a version in its marketplaces only after npm has it.
