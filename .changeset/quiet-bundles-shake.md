---
"@tinycloud/bootstrap": patch
"@tinycloud/sdk-core": patch
"@tinycloud/sdk-services": patch
"@tinycloud/web-sdk": patch
"@tinycloud/web-sdk-wasm": patch
"@tinycloud/node-sdk-wasm": patch
---

Reduce published SDK bundle and WASM artifact sizes by enabling safe package tree-shaking, using ES2020 output, removing release source maps, and optimizing WASM for size. `@tinycloud/sdk-services` keeps its published root entries in the `sideEffects` allowlist because they install debug globals at module scope.

Measured by rebuilding the `origin/master` baseline (`9d4866f`) and this release tree in this worktree. Values are raw bytes / gzip level 9 bytes (`gzip -9 -c`):

| Package entry | Before | After |
| --- | ---: | ---: |
| `@tinycloud/bootstrap` `capabilities.cjs` | 6062 / 1408 | 6062 / 1408 |
| `@tinycloud/bootstrap` `capabilities.js` | 4834 / 964 | 4834 / 964 |
| `@tinycloud/bootstrap` `generated/capabilities.cjs` | 7399 / 1546 | 7399 / 1546 |
| `@tinycloud/bootstrap` `generated/capabilities.js` | 5971 / 1051 | 5971 / 1051 |
| `@tinycloud/bootstrap` `index.cjs` | 24918 / 5318 | 24918 / 5318 |
| `@tinycloud/bootstrap` `index.js` | 21996 / 4684 | 21996 / 4684 |
| `@tinycloud/sdk-core` `bootstrap/index.cjs` | 1164 / 548 | 1164 / 548 |
| `@tinycloud/sdk-core` `bootstrap/index.js` | 97 / 114 | 97 / 114 |
| `@tinycloud/sdk-core` `delegations/index.cjs` | 310660 / 61313 | 309759 / 61082 |
| `@tinycloud/sdk-core` `delegations/index.js` | 301141 / 59881 | 300220 / 59637 |
| `@tinycloud/sdk-core` `index.cjs` | 636247 / 125252 | 636247 / 125252 |
| `@tinycloud/sdk-core` `index.js` | 607698 / 121703 | 607698 / 121703 |
| `@tinycloud/sdk-core` `policy/index.cjs` | 109334 / 22646 | 109334 / 22646 |
| `@tinycloud/sdk-core` `policy/index.js` | 104481 / 21537 | 104481 / 21537 |
| `@tinycloud/sdk-core` `requester/index.cjs` | 139251 / 29949 | 139251 / 29949 |
| `@tinycloud/sdk-core` `requester/index.js` | 135505 / 29028 | 135505 / 29028 |
| `@tinycloud/sdk-services` `encryption/index.cjs` | 44198 / 9624 | 44198 / 9624 |
| `@tinycloud/sdk-services` `encryption/index.js` | 41192 / 8904 | 41192 / 8904 |
| `@tinycloud/sdk-services` `index.cjs` | 216891 / 41034 | 216891 / 41034 |
| `@tinycloud/sdk-services` `index.js` | 209330 / 39470 | 209330 / 39470 |
| `@tinycloud/sdk-services` `internal/decrypt-transport-response-error.cjs` | 1540 / 681 | 1540 / 681 |
| `@tinycloud/sdk-services` `internal/decrypt-transport-response-error.js` | 419 / 268 | 419 / 268 |
| `@tinycloud/sdk-services` `kv/index.cjs` | 51068 / 10676 | 51068 / 10676 |
| `@tinycloud/sdk-services` `kv/index.js` | 49896 / 10259 | 49896 / 10259 |
| `@tinycloud/sdk-services` `sql/index.cjs` | 26895 / 6935 | 26895 / 6935 |
| `@tinycloud/sdk-services` `sql/index.js` | 25613 / 6530 | 25613 / 6530 |
| `@tinycloud/web-sdk` `index.cjs` | 3701304 / 1240268 | 3637285 / 1229488 |
| `@tinycloud/web-sdk` `index.mjs` | 3887911 / 1272304 | 3822218 / 1261105 |
| `@tinycloud/web-sdk-wasm` `index.js` | 1794903 / 695262 | 1752919 / 687800 |
| `@tinycloud/node-sdk-wasm` `index.cjs` | 61 / 91 | 61 / 91 |
| `@tinycloud/node-sdk-wasm` `index.js` | 1451 / 801 | 1451 / 801 |
| `@tinycloud/node-sdk-wasm` `wasm/index.cjs` | 68817 / 10479 | 68817 / 10479 |
| `@tinycloud/node-sdk-wasm` `wasm/tinycloud_web_sdk_rs_bg.wasm` | 1322615 / 514215 | 1290495 / 512421 |

The corrected `@tinycloud/web-sdk` dry-run pack contains 52 files and no `.map` files. `packages/web-sdk/tests/signInManifestRestore.test.ts` passed 8/8 with mocked auth under Bun. Live-wallet E2E was not run.
