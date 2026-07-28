---
"@tinycloud/bootstrap": patch
"@tinycloud/sdk-core": patch
"@tinycloud/sdk-services": patch
"@tinycloud/web-sdk": patch
"@tinycloud/web-sdk-wasm": patch
"@tinycloud/node-sdk-wasm": patch
---

Reduce published SDK bundle and WASM artifact sizes by enabling safe package tree-shaking, using ES2020 output, removing release source maps, and optimizing WASM for size. `@tinycloud/sdk-services` keeps `src/debug.ts` in its `sideEffects` allowlist because it installs debug globals at module scope.

Measured from `origin/master` (`959b428`) to this release tree. Values are raw bytes / gzip level 9 bytes:

| Package entry | Before | After |
| --- | ---: | ---: |
| `@tinycloud/bootstrap` `capabilities.cjs` | 6062 / 1393 | 6062 / 1393 |
| `@tinycloud/bootstrap` `capabilities.js` | 4834 / 947 | 4834 / 947 |
| `@tinycloud/bootstrap` `generated/capabilities.cjs` | 7399 / 1529 | 7399 / 1529 |
| `@tinycloud/bootstrap` `generated/capabilities.js` | 5971 / 1036 | 5971 / 1036 |
| `@tinycloud/bootstrap` `index.cjs` | 24918 / 5327 | 24918 / 5327 |
| `@tinycloud/bootstrap` `index.js` | 21996 / 4688 | 21996 / 4688 |
| `@tinycloud/sdk-core` `bootstrap/index.cjs` | 1164 / 538 | 1164 / 538 |
| `@tinycloud/sdk-core` `bootstrap/index.js` | 97 / 105 | 97 / 105 |
| `@tinycloud/sdk-core` `index.cjs` | 455201 / 92069 | 454895 / 92061 |
| `@tinycloud/sdk-core` `index.js` | 431236 / 89180 | 430930 / 89175 |
| `@tinycloud/sdk-core` `policy/index.cjs` | 109484 / 22755 | 109334 / 22748 |
| `@tinycloud/sdk-core` `policy/index.js` | 104631 / 21643 | 104481 / 21630 |
| `@tinycloud/sdk-core` `requester/index.cjs` | 139395 / 30112 | 139251 / 30107 |
| `@tinycloud/sdk-core` `requester/index.js` | 135649 / 29179 | 135505 / 29178 |
| `@tinycloud/sdk-services` `encryption/index.cjs` | 44198 / 9647 | 44198 / 9647 |
| `@tinycloud/sdk-services` `encryption/index.js` | 41192 / 8918 | 41192 / 8918 |
| `@tinycloud/sdk-services` `index.cjs` | 215989 / 40916 | 215989 / 40916 |
| `@tinycloud/sdk-services` `index.js` | 208450 / 39344 | 208450 / 39344 |
| `@tinycloud/sdk-services` `internal/decrypt-transport-response-error.cjs` | 1540 / 643 | 1540 / 643 |
| `@tinycloud/sdk-services` `internal/decrypt-transport-response-error.js` | 419 / 231 | 419 / 231 |
| `@tinycloud/sdk-services` `kv/index.cjs` | 50733 / 10639 | 50733 / 10639 |
| `@tinycloud/sdk-services` `kv/index.js` | 49561 / 10214 | 49561 / 10214 |
| `@tinycloud/sdk-services` `sql/index.cjs` | 26895 / 6944 | 26895 / 6944 |
| `@tinycloud/sdk-services` `sql/index.js` | 25613 / 6536 | 25613 / 6536 |
| `@tinycloud/web-sdk` `index.cjs` | 3535517 / 1200787 | 3527155 / 1199803 |
| `@tinycloud/web-sdk` `index.mjs` | 3691280 / 1229359 | 3681809 / 1227903 |
| `@tinycloud/web-sdk-wasm` `index.js` | 1794903 / 691501 | 1752919 / 684335 |
| `@tinycloud/node-sdk-wasm` `index.cjs` | 61 / 81 | 61 / 81 |
| `@tinycloud/node-sdk-wasm` `index.js` | 1451 / 790 | 1451 / 790 |
| `@tinycloud/node-sdk-wasm` `wasm/index.cjs` | 68817 / 10483 | 68817 / 10483 |
| `@tinycloud/node-sdk-wasm` `wasm/tinycloud_web_sdk_rs_bg.wasm` | 1322615 / 518174 | 1290495 / 516585 |

The corrected `@tinycloud/web-sdk` pack is 2457738 bytes versus 7212375 bytes before; its package contents contain no `.map` files. The `apps/openkey-vite` consumer build succeeded, and `packages/web-sdk/tests/signInManifestRestore.test.ts` passed 8/8 with mocked auth. Live-wallet E2E was not run.
