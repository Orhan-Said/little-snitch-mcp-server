# Releasing

How a new version reaches npm. The workflow builds and stages it, and only the maintainer can make it public, with two-factor authentication.

1. Set the new version in `package.json` and `package-lock.json`, and add it to `CHANGELOG.md`:

   ```bash
   npm version 0.1.1 --no-git-tag-version
   ```

2. Commit, push to `main`, and wait until CI passes.
3. Tag that commit and push the tag. A tag cannot be moved or deleted afterwards, so tag only a commit whose CI passed.

   ```bash
   git tag -a v0.1.1 -m "0.1.1"
   git push origin refs/tags/v0.1.1
   ```

4. The Release workflow checks that the tag matches the version, runs the type-check, the tests and the build, and stages the version on npm. Its log ends with `+ little-snitch-mcp-server@0.1.1 (staged with id <id>)`. Nothing is public yet.
5. Look at what was staged:

   ```bash
   npm stage list little-snitch-mcp-server
   npm stage view <id>
   npm stage download <id>
   ```

   `download` saves the tarball in the current folder. `tar -tzf <file>` lists what is in it.
6. Approve it. npm asks for two-factor authentication.

   ```bash
   npm stage approve <id>
   ```

   If something is wrong, `npm stage reject <id>` deletes the staged version. The tag cannot move, so release the fix as the next version.
7. Check the release from the registry: `npm view little-snitch-mcp-server@0.1.1`, and `npm audit signatures` in a project that installs it.
8. Create the GitHub release from the changelog entry:

   ```bash
   gh release create v0.1.1 --verify-tag --title "0.1.1" --notes-file <file with the changelog entry>
   ```

## What protects a release

- npm trusts one publisher for the package: GitHub Actions, repository `Orhan-Said/little-snitch-mcp-server`, workflow `release.yml`, environment `npm`, allowed to stage and not to publish.
- The package's access setting on npm requires two-factor authentication for every publish and refuses tokens.
- The `npm` environment on GitHub accepts only `v*` tags, and tags cannot be moved or deleted.
- The workflow uses only GitHub's own actions, each pinned to a commit, and no cache.
