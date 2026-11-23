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

There is one release path in this repo: stable releases from `master`. Pre mode and the beta cycle are gone (no `.changeset/pre.json`).

### Stable releases: via changesets, from master, scoped

`.github/workflows/changesets.yml` runs on every push to `master`. It versions and publishes plain stable versions to the `latest` dist-tag for **only** the packages listed in `.github/release-scope.json`. Every other workspace package keeps its version, CHANGELOG and pending changesets until a maintainer adds it to that list. The `enabled` field in that file is the only switch: while it is `false`, a push to `master` releases nothing.

The `Release` job:

1. Counts pending changesets that name an in-scope package (a changeset naming both kinds is split at release time; the held part is written back unchanged).
2. Requires a maintainer sign-off for any pending `major` changeset (`check-major-release-signoff.mjs release`) and refuses to start while an earlier release is unfinished.
3. Runs `scoped-version.mjs version`: `changeset version`, then every out-of-scope package is put back (a dependent bump is not a release), and the result is refused unless each in-scope bump is a stable same-major increase, matches the locked inventory (`expect`, when set), and no in-scope package requires a prerelease of a package outside the scope.
4. Builds, checks the CLI's node release pin and the internal dependency pins, and commits `chore: release stable packages [skip ci]`.
5. Checks npm (provenance and earlier accepted-but-not-visible versions) for the packages that commit versioned, pushes the commit to `master` with the release deploy key, then publishes in dependency order, waiting for npm to serve each layer.
6. Confirms npm has every released version; `GitHub Releases` creates one GitHub Release per published package version.

`node .github/scripts/scoped-version.mjs plan` runs step 3 in a throwaway copy and prints the inventory.

Guards:

- A pending `major` changeset releases only after an `approve-major-release:` line naming the package appears in a commit message between the commit that added the changeset and `master`'s HEAD.
- If the push fails, nothing is published; the run for the newer commit releases the changesets.
- If a run pushed but did not finish publishing, dispatch the workflow with `resume: release`: it publishes exactly the missing versions from their release commit and versions nothing. Pushes refuse to run until then.
- A version staged earlier from another commit (the Courier 0.8.0 set) is a baseline: provenance and publishing look only at packages the release commit versioned, and a missing baseline stops the run instead of being published from master's source.

To release a held package, a maintainer adds it to `packages` in `.github/release-scope.json` in a reviewed PR, with its manifest at its last stable release.

Break-glass only: `.github/workflows/raw-publish.yml` (manual dispatch, optional dist-tag override and dry run) publishes each package at its current version and skips versions npm already has. It does not run changeset versioning, the release scope, or the GitHub release steps, so create the GitHub release by hand.

### How releases push

`changesets.yml` pushes its release commits (`chore: release stable packages [skip ci]`) to `master` over SSH with a **deploy key**, not a personal access token. Every release commit carries `[skip ci]`, so the push does not start another release run.

- **Secret:** `RELEASE_DEPLOY_KEY` (repository secret) holds the private half of the key. The public half is a deploy key on `TinyCloudLabs/js-sdk` with **write access**.
- **Ruleset bypass:** when `master` is protected, the deploy key is the only actor allowed to bypass the ruleset, so it is the only way for the workflow to push straight to `master`. Everything else goes through pull requests.
- **How it is used:** `.github/scripts/release-deploy-key.sh install` writes the key to a `0600` file under `$RUNNER_TEMP` and pins GitHub's published host keys; the push steps run `git push git@github.com:TinyCloudLabs/js-sdk.git master` with `GIT_SSH_COMMAND` set to `-o IdentitiesOnly=yes -o StrictHostKeyChecking=yes` against that file. The key is never printed and is removed when the job ends.
- **Fails closed:** if `RELEASE_DEPLOY_KEY` is missing or unreadable, the job fails before `changeset version` runs. There is no fallback to `GH_TOKEN` for pushes.
- **Key lifetime:** each job deletes the key right after its master push succeeds, and again in an `always()` cleanup step. Pushes use `ssh -F /dev/null`, so no ssh config on the runner applies.
- **Release calls use the job token:** the `GitHub Releases` job alone has `contents: write`; the `Release` and `Release resume` jobs have `contents: read` and `id-token: write` for npm provenance, and publish with `NPM_TOKEN`.

## Practical guidance

**When adding a changeset via `bun changeset add`:**

- If your change only touches TypeScript (most PRs): select only the TS packages that are affected. Do **not** select `@tinycloud/web-sdk-wasm` or `@tinycloud/node-sdk-wasm`.
- If your change touches Rust code under `packages/sdk-rs/`: include the WASM packages. Consider whether a TS-level bump is also needed (it usually is, because consumer packages pin the WASM version).
- Never select the WASM packages "to be safe" — they have an independent changelog and you will create a noisy, misleading release entry.

**When bumping the `tinycloud-node` dependency rev in `packages/sdk-rs/Cargo.toml`:**

- This is a WASM-affecting change. Add a changeset that bumps `@tinycloud/web-sdk-wasm` and `@tinycloud/node-sdk-wasm`.
- The TS packages that consume the WASM output (web-sdk, node-sdk) need to be updated to pin the new WASM version, which means they also need a changeset entry.

**When in doubt:** look at the WASM packages' CHANGELOG.md files (`packages/sdk-rs/packages/web/CHANGELOG.md`, `packages/sdk-rs/packages/node/CHANGELOG.md`). Every past bump has a concrete Rust/WASM reason. If your change doesn't fit that pattern, don't bump them.
