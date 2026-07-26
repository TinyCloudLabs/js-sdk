---
"@tinycloud/bootstrap": patch
"@tinycloud/sdk-core": patch
"@tinycloud/sdk-services": patch
"@tinycloud/web-sdk": patch
"@tinycloud/web-sdk-wasm": patch
"@tinycloud/node-sdk-wasm": patch
---

Reduce published SDK bundle and WASM artifact sizes by enabling safe package tree-shaking, using ES2020 output, removing release source maps, and optimizing WASM for size.
