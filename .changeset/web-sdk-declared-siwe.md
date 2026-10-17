---
"@tinycloud/web-sdk": patch
---

The published `index.d.ts` no longer imports the undeclared `siwe` package; the replica bridge re-exports `SiweMessage` through `@tinycloud/sdk-core`, so strict installs (for example pnpm) resolve every type import.
