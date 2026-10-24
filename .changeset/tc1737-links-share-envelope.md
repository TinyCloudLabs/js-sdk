---
"@tinycloud/share-envelope": minor
---

Add the `@tinycloud/share-envelope/links` subpath: typed, issuer-signed link records and the `#v=4` link grammar. It runs in browsers and in Node, using WebCrypto (`globalThis.crypto`) and `fetch` only.

- Records: a strict signed header (type, issuer, audience, issuedAt, expiresAt, size, bodyCid, nonce), an Ed25519 signature over `SHA-256(domain ‖ JCS(header))`, and a sealed body. One body limit, `MAX_LINK_BODY_BYTES` (65,536 bytes), applies to every type; a body over it has neither a short nor a full link.
- Signers: `createLink`, `deleteLink`, `prepareLinkRecord`, `signHeader` and `signDelete` take a `LinkSigner` (`{ did, sign(digest) }`), so the caller keeps its private key. `signerFromSeed` and `signerFromJwk` build one for tests and simple callers.
- Links: `buildShortLink`, `buildFullLink`, `parseLink` (strict grammar, both forms) and `resolveLink` (the full reader pipeline, an optional `validateBody` hook, and one `LinkError` class with a `code` per refusal).
- Delivery helpers: `shortShareLinkCid(href)` gives the `c` of a short share link and `undefined` for any other string; `redactLink(text, href)` replaces a link and the key in its `k=` parameter in a text.
- Verification: `verifyEd25519Strict` applies one Ed25519 rule everywhere (`S < ℓ`, canonical and prime-order `A` and `R`).
- The links vectors from the TC-1737 contract (`packages/share-envelope/test/links-api-vectors.json`, SHA-256 pinned in a test) drive the tests.
- Packaging: the reader is its own file, `dist/links.js` (`dist/links.cjs`), built apart from `dist/index.js`. Its dependencies (`zod`, `@noble/curves`, `@noble/hashes`, `multiformats`) are package imports, so a bundler that already holds them adds no second copy.

Removed:

- The `@tinycloud/share-envelope/short-link` subpath and the `#v=3` codec (`SHORT_LINK_ID_PATTERN`, `parseShortShareUrl`, `splitInlineToShort`, `rebuildInlineFromShort`).
- The inline `#v=2&p=` link codec (`encodeSealedInlineShareUrl`, `parseSealedInlineShareUrl` and their types).
- The delete-token handling.
- `test/shortlink-vectors.json`.

The compact `/s/<cid>#k=` link (`encodeShareUrl`, `parseShareUrl`) is unchanged.

Do not release before the deploy window for the links API, witness, node, Share web and CLI.

Details: TC-1737
