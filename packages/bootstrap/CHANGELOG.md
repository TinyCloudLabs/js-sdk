# @tinycloud/bootstrap

## 2.6.1-beta.0

### Patch Changes

- 68faad4: Reduce published SDK bundle and WASM artifact sizes by enabling safe package tree-shaking, using ES2020 output, removing release source maps, and optimizing WASM for size. `@tinycloud/sdk-services` keeps its published root entries in the `sideEffects` allowlist because they install debug globals at module scope.

  Measured by rebuilding the `origin/master` baseline (`9d4866f`) and this release tree in this worktree. Values are raw bytes / gzip level 9 bytes (`gzip -9 -c`):

  | Package entry                                                             |            Before |             After |
  | ------------------------------------------------------------------------- | ----------------: | ----------------: |
  | `@tinycloud/bootstrap` `capabilities.cjs`                                 |       6062 / 1408 |       6062 / 1408 |
  | `@tinycloud/bootstrap` `capabilities.js`                                  |        4834 / 964 |        4834 / 964 |
  | `@tinycloud/bootstrap` `generated/capabilities.cjs`                       |       7399 / 1546 |       7399 / 1546 |
  | `@tinycloud/bootstrap` `generated/capabilities.js`                        |       5971 / 1051 |       5971 / 1051 |
  | `@tinycloud/bootstrap` `index.cjs`                                        |      24918 / 5318 |      24918 / 5318 |
  | `@tinycloud/bootstrap` `index.js`                                         |      21996 / 4684 |      21996 / 4684 |
  | `@tinycloud/sdk-core` `bootstrap/index.cjs`                               |        1164 / 548 |        1164 / 548 |
  | `@tinycloud/sdk-core` `bootstrap/index.js`                                |          97 / 114 |          97 / 114 |
  | `@tinycloud/sdk-core` `delegations/index.cjs`                             |    310660 / 61313 |    309759 / 61082 |
  | `@tinycloud/sdk-core` `delegations/index.js`                              |    301141 / 59881 |    300220 / 59637 |
  | `@tinycloud/sdk-core` `index.cjs`                                         |   636247 / 125252 |   636247 / 125252 |
  | `@tinycloud/sdk-core` `index.js`                                          |   607698 / 121703 |   607698 / 121703 |
  | `@tinycloud/sdk-core` `policy/index.cjs`                                  |    109334 / 22646 |    109334 / 22646 |
  | `@tinycloud/sdk-core` `policy/index.js`                                   |    104481 / 21537 |    104481 / 21537 |
  | `@tinycloud/sdk-core` `requester/index.cjs`                               |    139251 / 29949 |    139251 / 29949 |
  | `@tinycloud/sdk-core` `requester/index.js`                                |    135505 / 29028 |    135505 / 29028 |
  | `@tinycloud/sdk-services` `encryption/index.cjs`                          |      44198 / 9624 |      44198 / 9624 |
  | `@tinycloud/sdk-services` `encryption/index.js`                           |      41192 / 8904 |      41192 / 8904 |
  | `@tinycloud/sdk-services` `index.cjs`                                     |    216891 / 41034 |    216891 / 41034 |
  | `@tinycloud/sdk-services` `index.js`                                      |    209330 / 39470 |    209330 / 39470 |
  | `@tinycloud/sdk-services` `internal/decrypt-transport-response-error.cjs` |        1540 / 681 |        1540 / 681 |
  | `@tinycloud/sdk-services` `internal/decrypt-transport-response-error.js`  |         419 / 268 |         419 / 268 |
  | `@tinycloud/sdk-services` `kv/index.cjs`                                  |     51068 / 10676 |     51068 / 10676 |
  | `@tinycloud/sdk-services` `kv/index.js`                                   |     49896 / 10259 |     49896 / 10259 |
  | `@tinycloud/sdk-services` `sql/index.cjs`                                 |      26895 / 6935 |      26895 / 6935 |
  | `@tinycloud/sdk-services` `sql/index.js`                                  |      25613 / 6530 |      25613 / 6530 |
  | `@tinycloud/web-sdk` `index.cjs`                                          | 3701304 / 1240268 | 3637285 / 1229488 |
  | `@tinycloud/web-sdk` `index.mjs`                                          | 3887911 / 1272304 | 3822218 / 1261105 |
  | `@tinycloud/web-sdk-wasm` `index.js`                                      |  1794903 / 695262 |  1752919 / 687800 |
  | `@tinycloud/node-sdk-wasm` `index.cjs`                                    |           61 / 91 |           61 / 91 |
  | `@tinycloud/node-sdk-wasm` `index.js`                                     |        1451 / 801 |        1451 / 801 |
  | `@tinycloud/node-sdk-wasm` `wasm/index.cjs`                               |     68817 / 10479 |     68817 / 10479 |
  | `@tinycloud/node-sdk-wasm` `wasm/tinycloud_web_sdk_rs_bg.wasm`            |  1322615 / 514215 |  1290495 / 512421 |

  The corrected `@tinycloud/web-sdk` dry-run pack contains 52 files and no `.map` files. `packages/web-sdk/tests/signInManifestRestore.test.ts` passed 8/8 with mocked auth under Bun. Live-wallet E2E was not run.

## 2.6.0

### Minor Changes

- f7a1d4f: Add signed account-wide delegation history queries with lifecycle and revocation
  status, plus CID-bound delegation revocation receipts and the account-scoped
  delegation control capabilities used by SDK sessions.

### Patch Changes

- 940ff1d: Bundle the bootstrap package's internal graph so its advertised CommonJS entrypoints load on supported Node 20 runtimes.
- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.

## 2.6.0-beta.1

### Patch Changes

- 940ff1d: Bundle the bootstrap package's internal graph so its advertised CommonJS entrypoints load on supported Node 20 runtimes.
- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.

## 2.6.0-beta.0

### Minor Changes

- f7a1d4f: Add signed account-wide delegation history queries with lifecycle and revocation
  status, plus CID-bound delegation revocation receipts and the account-scoped
  delegation control capabilities used by SDK sessions.

## 2.5.1

### Patch Changes

- cd2aeb1: Fix Node-ESM `ERR_MODULE_NOT_FOUND` in `@tinycloud/bootstrap` 2.5.0.

  The TC-112 capability-SSOT refactor split a vendored `capabilities` module out
  of the previously-inlined build, but the tsup config uses `bundle: false`, so
  the extensionless source imports (`from "./capabilities"`,
  `from "./generated/capabilities"`) survived verbatim into `dist/index.js` and
  `dist/capabilities.js`. Node's ESM resolver requires explicit file extensions,
  so every Node-ESM consumer (e.g. Listen's vitest suites) got
  `ERR_MODULE_NOT_FOUND` on import; the CJS entry hit the same error via
  require-of-ESM. Bundlers (vite) and Bun tolerate the missing extension, which is
  why builds passed. 2.4.1 was fully inlined and unaffected.

  Fix: make the source relative imports extensionful (`./capabilities.js`,
  `./generated/capabilities.js`), which TypeScript's `bundler` module resolution
  accepts and which produces resolvable ESM and CJS output.

## 2.5.1-beta.0

### Patch Changes

- cd2aeb1: Fix Node-ESM `ERR_MODULE_NOT_FOUND` in `@tinycloud/bootstrap` 2.5.0.

  The TC-112 capability-SSOT refactor split a vendored `capabilities` module out
  of the previously-inlined build, but the tsup config uses `bundle: false`, so
  the extensionless source imports (`from "./capabilities"`,
  `from "./generated/capabilities"`) survived verbatim into `dist/index.js` and
  `dist/capabilities.js`. Node's ESM resolver requires explicit file extensions,
  so every Node-ESM consumer (e.g. Listen's vitest suites) got
  `ERR_MODULE_NOT_FOUND` on import; the CJS entry hit the same error via
  require-of-ESM. Bundlers (vite) and Bun tolerate the missing extension, which is
  why builds passed. 2.4.1 was fully inlined and unaffected.

  Fix: make the source relative imports extensionful (`./capabilities.js`,
  `./generated/capabilities.js`), which TypeScript's `bundler` module resolution
  accepts and which produces resolvable ESM and CJS output.

## 2.5.0

### Minor Changes

- 2f31800: Consolidate hand-written capability URN lists into a single source of truth
  (`@tinycloud/bootstrap` `capabilities` module, TC-112). The registry is defined
  in tinycloud-node and vendored verbatim as
  `@tinycloud/bootstrap/src/generated/capabilities.ts`; the per-service constants
  (`KV`, `SQL`, `DUCKDB`, …), `CAPABILITY_REGISTRY`, `SQLAction`, `DuckDbAction`,
  the node-sdk default abilities and root-delegation grants, the bootstrap
  manifests, and the web-sdk permission-modal labels are all derived from it. A CI
  job diffs the vendored copy against the node registry at the pinned rev so the
  SDK can never silently drift from the enforcer.

  BREAKING (minor, pre-1.0): `SQLAction.INSERT`, `SQLAction.UPDATE`, and
  `SQLAction.DELETE` are removed — they were never dispatched by the SDK nor
  accepted by the node. `SQLAction.SELECT` is retained as a deprecated alias of
  `read`. `SQLAction.EXECUTE`/`EXPORT` and `DuckDbAction.DESCRIBE`/`EXECUTE` are
  retained as exported constants but are request-kind artifacts, not registry
  capabilities (the node routes them by request-body kind; wire alignment tracked
  in TC-114). All other action shapes are unchanged.

## 2.5.0-beta.0

### Minor Changes

- 2f31800: Consolidate hand-written capability URN lists into a single source of truth
  (`@tinycloud/bootstrap` `capabilities` module, TC-112). The registry is defined
  in tinycloud-node and vendored verbatim as
  `@tinycloud/bootstrap/src/generated/capabilities.ts`; the per-service constants
  (`KV`, `SQL`, `DUCKDB`, …), `CAPABILITY_REGISTRY`, `SQLAction`, `DuckDbAction`,
  the node-sdk default abilities and root-delegation grants, the bootstrap
  manifests, and the web-sdk permission-modal labels are all derived from it. A CI
  job diffs the vendored copy against the node registry at the pinned rev so the
  SDK can never silently drift from the enforcer.

  BREAKING (minor, pre-1.0): `SQLAction.INSERT`, `SQLAction.UPDATE`, and
  `SQLAction.DELETE` are removed — they were never dispatched by the SDK nor
  accepted by the node. `SQLAction.SELECT` is retained as a deprecated alias of
  `read`. `SQLAction.EXECUTE`/`EXPORT` and `DuckDbAction.DESCRIBE`/`EXECUTE` are
  retained as exported constants but are request-kind artifacts, not registry
  capabilities (the node routes them by request-body kind; wire alignment tracked
  in TC-114). All other action shapes are unchanged.

## 2.4.1

### Patch Changes

- 3b23940: Fix bootstrap space manifests granting unusable root capabilities. The default, applications, and public space manifests declared kv/sql permissions with `path: "/"`, which the recap encoder joined into resources like `applications/sql//` (double slash). The node's byte-prefix resource matching can never extend such a resource, so every invocation riding a bootstrap session delegation was rejected with "Unauthorized Action" — this is what broke Listen's first conversations query after OpenKey auto-sign bootstrap. Root permissions now use `path: ""`, which encodes as `applications/sql` and correctly covers all paths under the service.

## 2.4.1-beta.0

### Patch Changes

- 3b23940: Fix bootstrap space manifests granting unusable root capabilities. The default, applications, and public space manifests declared kv/sql permissions with `path: "/"`, which the recap encoder joined into resources like `applications/sql//` (double slash). The node's byte-prefix resource matching can never extend such a resource, so every invocation riding a bootstrap session delegation was rejected with "Unauthorized Action" — this is what broke Listen's first conversations query after OpenKey auto-sign bootstrap. Root permissions now use `path: ""`, which encodes as `applications/sql` and correctly covers all paths under the service.

## 2.4.0

### Patch Changes

- 79dd26c: Add the canonical account bootstrap manifest package, shared bootstrap schemas/allowlist, OpenKey callback signing strategy, and first-sign-in SDK bootstrap orchestration for enshrined spaces.
