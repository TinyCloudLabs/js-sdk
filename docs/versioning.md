# Package versioning policy

This monorepo publishes two families of packages to npm that move on **independent release cadences**. This is intentional. Do not try to align them.

## Package families

### TypeScript SDK family (linked, move together)

- `@tinycloud/sdk-core`
- `@tinycloud/sdk-services`
- `@tinycloud/node-sdk`
- `@tinycloud/web-sdk`

These are declared as a `linked` group in `.changeset/config.json` and are always bumped to the same version. `@tinycloud/cli` tracks this family closely but is not formally linked (it versions independently so it can have patch-only releases).

Current line: `3.x` (latest stable: `3.3.0`).

### WASM bindings family (independent, only bumped on Rust/WASM output changes)

- `@tinycloud/web-sdk-wasm`
- `@tinycloud/node-sdk-wasm`

These are wasm-pack outputs from the Rust crates in `packages/sdk-rs/`. They are bumped **only when the generated WASM or its TypeScript glue actually changes**. They are not in the linked group with the TypeScript SDK family and they are not co-bumped on TS-only releases.

Current line: `1.x` (latest stable: `1.7.7` for `web-sdk-wasm`, `1.7.8` for `node-sdk-wasm`).

**Triggers that warrant a WASM package bump:**

- `packages/sdk-rs/Cargo.toml` rev update to `tinycloud-node` (or any other Rust dep that changes the wasm-bindgen output)
- New exported function / changed signature in the Rust layer
- wasm-pack output format change (e.g. the CJS/ESM resolution fix in 1.4.1)
- Crate renames that affect the bindings (e.g. 1.6.0/1.7.0)

**Things that do NOT warrant a WASM bump:**

- Changes to files under `packages/web-sdk/`, `packages/node-sdk/`, `packages/sdk-core/`, `packages/sdk-services/` only
- TypeScript-level bug fixes
- CI / tooling / docs changes

If your change is TS-only, do not include the WASM packages in your changeset.

## Why the version lines diverged

The TS SDK had a `1.x` → `2.x` major release (`866981c`, "v1.0.0") that was then followed by `2.x` restructuring. The WASM bindings were not affected by those TS-level API changes and stayed on `1.x`. There has been no WASM API break that would warrant a `2.x` bump. This is expected and will continue — the version numbers are not intended to match across families.

As a concrete example: `@tinycloud/web-sdk@2.0.4` pins `@tinycloud/web-sdk-wasm@1.7.1` in its published dependency manifest. That is the correct, intentional state.

## How releases actually happen

There are two release paths in this repo and you need to know which one you're looking at.

### Beta releases: via changesets, from master

`.github/workflows/changesets.yml` runs on every push to `master`. If there are pending changeset files under `.changeset/*.md`, it runs `bun changeset version` (which consumes them and emits beta version bumps, because the repo is held in pre-mode), then publishes to npm under the `beta` dist-tag, then commits the version bumps back to master with `[skip ci]`.

This path only works while `.changeset/pre.json` is present. Do not run `bun changeset pre exit` casually — that file is what makes `changeset version` produce `X.Y.Z-beta.N` instead of a stable bump. The team uses pre-mode as the steady state.

### Stable releases: via the Stable Release job

Stable releases are cut by the `Stable Release` job in `.github/workflows/changesets.yml`. It runs only on manual dispatch with `confirm` set to `release`, and only from `master`:

```bash
gh workflow run changesets.yml --ref master -f confirm=release
```

The job:

1. Exits pre mode (`bun changeset pre exit`) and runs `bun changeset version`, which turns pending changesets into stable versions.
2. Builds, checks the CLI's node release pin, and commits `chore: release stable packages`.
3. Commits `chore: enter beta pre-release mode` (`bun changeset pre enter beta`) on top of it.
4. Pushes both commits to `master` in one push using the release deploy key, then publishes to npm under the `latest` dist-tag.
5. Confirms npm has every current version, then creates the GitHub release `v<web-sdk version>` at the release commit.

Because the job re-enters beta mode itself, `.changeset/pre.json` needs no manual rebaseline after a stable release.

Guards:

- A stable release that graduates a package to a higher major than it had when it entered pre mode fails unless the release has an `approve-major-release:` sign-off commit.
- If the push fails, nothing is published. Dispatch the job again.
- If an earlier stable run pushed but did not finish publishing, the next dispatch finishes that release from its commit and graduates nothing new. Beta runs refuse to run until then.

Break-glass only: `.github/workflows/raw-publish.yml` (manual dispatch, optional dist-tag override and dry run) publishes each package at its current version and skips versions npm already has. It does not run the pre-mode, changeset versioning, or GitHub release steps, so afterwards check `.changeset/pre.json` and create the GitHub release by hand.

### How releases push

`changesets.yml` pushes its release commits (`chore: beta version packages`, `chore: release stable packages`, `chore: enter beta pre-release mode`) to `master` over SSH with a **deploy key**, not a personal access token.

- **Secret:** `RELEASE_DEPLOY_KEY` (repository secret) holds the private half of the key. The public half is a deploy key on `TinyCloudLabs/js-sdk` with **write access**.
- **Ruleset bypass:** when `master` is protected, the deploy key is the only actor allowed to bypass the ruleset, so it is the only way for the workflow to push straight to `master`. Everything else goes through pull requests.
- **How it is used:** `.github/scripts/release-deploy-key.sh install` writes the key to a `0600` file under `$RUNNER_TEMP` and pins GitHub's published host keys; the push steps run `git push git@github.com:TinyCloudLabs/js-sdk.git master` with `GIT_SSH_COMMAND` set to `-o IdentitiesOnly=yes -o StrictHostKeyChecking=yes` against that file. The key is never printed and is removed when the job ends.
- **Fails closed:** if `RELEASE_DEPLOY_KEY` is missing or unreadable, the job fails before `changeset version` runs. There is no fallback to `GH_TOKEN` for pushes.
- **Key lifetime:** each job deletes the key right after its master push succeeds, and again in an `always()` cleanup step. Pushes use `ssh -F /dev/null`, so no ssh config on the runner applies.
- **Release calls use the job token:** `gh release create` / `gh release view` in the stable job use `github.token` (the stable job alone has `contents: write`; the beta job has `contents: read`). Neither job needs `id-token`: publishing uses `NPM_TOKEN`, with no provenance.

## Practical guidance

**When adding a changeset via `bun changeset add`:**

- If your change only touches TypeScript (most PRs): select only the TS packages that are affected. Do **not** select `@tinycloud/web-sdk-wasm` or `@tinycloud/node-sdk-wasm`.
- If your change touches Rust code under `packages/sdk-rs/`: include the WASM packages. Consider whether a TS-level bump is also needed (it usually is, because consumer packages pin the WASM version).
- Never select the WASM packages "to be safe" — they have an independent changelog and you will create a noisy, misleading release entry.

**When bumping the `tinycloud-node` dependency rev in `packages/sdk-rs/Cargo.toml`:**

- This is a WASM-affecting change. Add a changeset that bumps `@tinycloud/web-sdk-wasm` and `@tinycloud/node-sdk-wasm`.
- The TS packages that consume the WASM output (web-sdk, node-sdk) need to be updated to pin the new WASM version, which means they also need a changeset entry.

**When in doubt:** look at the WASM packages' CHANGELOG.md files (`packages/sdk-rs/packages/web/CHANGELOG.md`, `packages/sdk-rs/packages/node/CHANGELOG.md`). Every past bump has a concrete Rust/WASM reason. If your change doesn't fit that pattern, don't bump them.
