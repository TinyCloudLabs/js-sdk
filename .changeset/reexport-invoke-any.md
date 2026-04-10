---
"@tinycloud/node-sdk-wasm": patch
"@tinycloud/web-sdk-wasm": patch
---

Re-export `invokeAny` from the node and web WASM bindings. Unblocks `@tinycloud/node-sdk@2.1.x`, which imports `invokeAny` at module load; against the published `@tinycloud/node-sdk-wasm@1.7.1` artifact (built before the symbol existed) consumers hit `SyntaxError: Export named 'invokeAny' not found in module '@tinycloud/node-sdk-wasm'`. The Rust source and TypeScript wrappers already expose `invokeAny` on master (PR #173); this changeset exists to trigger a new WASM release so the symbol reaches npm.
