---
"@tinycloud/sdk-core": patch
---

Stop pulling the Node `crypto-browserify` polyfill tree (crypto-browserify, elliptic,
asn1.js, diffie-hellman, public-encrypt, create-ecdh, miller-rabin, bn.js,
browserify-sign, md5.js, ripemd160, sha.js, hash.js, readable-stream, vm-browserify)
into downstream browser bundles (TC-291).

`packages/sdk-core/tsup.config.ts` bundles `multiformats` and the `@multiformats/*`
packages (`noExternal`) so the published CJS entrypoints don't emit unsupported
`require()` calls for these ESM-only packages. tsup/esbuild defaults to `platform:
"node"` for that bundling step, which resolves each dependency's `package.json`
`"exports"`/`"browser"` conditions as Node would — so the *published* `sdk-core`
dist ended up with a literal `import crypto from "crypto"` inlined from
`multiformats/dist/src/hashes/sha2.js`, and a literal `import vm from "vm"` inlined
from `function-timeout` (reached via `@chainsafe/is-ip`'s `"node"`-conditioned export
inside `@multiformats/multiaddr`'s IP parsing). No downstream bundler could ever pick
either package's browser-safe variant, because the Node variant was already baked in
before the consumer's bundler ever saw the code. Webpack then satisfied the bare
`crypto`/`vm` imports via its `resolve.fallback` polyfills, dragging in the entire tree.

Fix: set `platform: "browser"` on the tsup config. This does not externalize anything
(so the CJS entrypoint constraint that motivated `noExternal` is untouched — it's still
a single self-contained bundle) — it only changes which `"exports"`/`"browser"`
conditions esbuild satisfies while resolving the bundled subtree, so `multiformats`
inlines its WebCrypto-based hasher (`crypto.subtle.digest`) and `@chainsafe/is-ip` /
`function-timeout` inline their non-Node variants (no `vm`). Node 20+ (this package's
`engines` floor) ships a global `WebCrypto` (`globalThis.crypto`), so the
browser-conditioned code runs correctly under Node too — both the ESM and CJS
entrypoints for every export (`.`, `./bootstrap`, `./policy`, `./requester`,
`./delegations`) still import and execute cleanly in Node, verified by actually
calling a `multiformats`-hashing function (`canonicalOwnerSharePolicy`) through each
built artifact and confirming the CID matches across ESM/CJS.

Measured with a minimal consumer bundle mirroring `packages/web-sdk/webpack.config.cjs`
(same `resolve.conditionNames`/`mainFields`/`fallback`, same plugins, `library: {type:
"module"}` output so the imports aren't tree-shaken away) importing
`@tinycloud/sdk-core` + `@tinycloud/sdk-core/delegations`:

| | Before | After |
| --- | ---: | ---: |
| raw | 1,954,970 B | 857,034 B |
| gzip -9 | 524,474 B | 248,893 B |

`crypto-browserify`, the real `elliptic` package, `vm-browserify`, `asn1.js`,
`browserify-sign`, `diffie-hellman`, `miller-rabin`, `create-ecdh`, and `md5.js` are
present in the "before" bundle's webpack module graph and entirely absent from
"after". The one remaining `bn.js`/`elliptic.js` hit after the fix is
`@ethersproject/signing-key`'s own file (real secp256k1 signing needed by
`siwe`/`ethers`, unrelated to this polyfill chain).

This harness was used instead of `packages/web-sdk`'s own build because that
package's `src/modules/tcw.ts` currently fails to typecheck against the current
`sdk-core`/`sdk-services` APIs for unrelated, pre-existing reasons (e.g.
`createOwnerDelegation` vs. the current `createDelegation`, missing
`@tinycloud/web-sdk-wasm` build output) — worth a look, but out of scope here.
