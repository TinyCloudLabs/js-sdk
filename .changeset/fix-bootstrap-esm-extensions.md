---
"@tinycloud/bootstrap": patch
---

Fix Node-ESM `ERR_MODULE_NOT_FOUND` in `@tinycloud/bootstrap` 2.5.0.

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
