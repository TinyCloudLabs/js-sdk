# Package versioning policy

This monorepo publishes two families of packages to npm that move on **independent release cadences**. This is intentional. Do not try to align them.

## Package families

### TypeScript SDK family (linked, move together)

- `@tinycloud/sdk-core`
- `@tinycloud/sdk-services`
- `@tinycloud/node-sdk`
- `@tinycloud/web-sdk`

These are declared as a `linked` group in `.changeset/config.json` and are always bumped to the same version. `@tinycloud/cli` tracks this family closely but is not formally linked (it versions independently so it can have patch-only releases).

Current line: `2.x` (latest stable: `2.0.4`).

### WASM bindings family (independent, only bumped on Rust/WASM output changes)

- `@tinycloud/web-sdk-wasm`
- `@tinycloud/node-sdk-wasm`

These are wasm-pack outputs from the Rust crates in `packages/sdk-rs/`. They are bumped **only when the generated WASM or its TypeScript glue actually changes**. They are not in the linked group with the TypeScript SDK family and they are not co-bumped on TS-only releases.

Current line: `1.x` (latest stable: `1.7.1`).

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

### Stable releases: via raw-publish.yml, manually

`.github/workflows/raw-publish.yml` is a break-glass manual publish path. Stable `2.0.x` releases have been cut through this workflow (see PR #180, `chore(release): 2.0.4 stable with SIWE nonce passthrough fix`), **not** through `changesets.yml`. The raw-publish path does its own `package.json` version edits out-of-band and publishes to `latest`. Because of this, stable releases do not flow through `changeset pre exit` / `changeset pre enter beta`, which means:

- `.changeset/pre.json` `initialVersions` can drift from reality and needs to be rebaselined by hand after a manual stable.
- The `changesets` array in `pre.json` can carry entries for changesets whose content was already shipped in a stable via raw-publish. Leaving them in place is fine — they will replay into the next pre-exit's aggregated changelog.

If you are cutting a stable, expect to manually update `pre.json`'s `initialVersions` afterwards. If you don't, the next beta cycle's computed versions will be based on a stale baseline.

## Practical guidance

**When adding a changeset via `bun changeset add`:**

- If your change only touches TypeScript (most PRs): select only the TS packages that are affected. Do **not** select `@tinycloud/web-sdk-wasm` or `@tinycloud/node-sdk-wasm`.
- If your change touches Rust code under `packages/sdk-rs/`: include the WASM packages. Consider whether a TS-level bump is also needed (it usually is, because consumer packages pin the WASM version).
- Never select the WASM packages "to be safe" — they have an independent changelog and you will create a noisy, misleading release entry.

**When bumping the `tinycloud-node` dependency rev in `packages/sdk-rs/Cargo.toml`:**

- This is a WASM-affecting change. Add a changeset that bumps `@tinycloud/web-sdk-wasm` and `@tinycloud/node-sdk-wasm`.
- The TS packages that consume the WASM output (web-sdk, node-sdk) need to be updated to pin the new WASM version, which means they also need a changeset entry.

**When in doubt:** look at the WASM packages' CHANGELOG.md files (`packages/sdk-rs/packages/web/CHANGELOG.md`, `packages/sdk-rs/packages/node/CHANGELOG.md`). Every past bump has a concrete Rust/WASM reason. If your change doesn't fit that pattern, don't bump them.
