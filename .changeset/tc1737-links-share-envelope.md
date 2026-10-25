---
"@tinycloud/share-envelope": minor
---

Add the `@tinycloud/share-envelope/links` subpath: typed, issuer-signed link records and the `#v=4` link grammar. It runs in browsers and in Node, using WebCrypto (`globalThis.crypto`) and `fetch` only.

- Records: a strict signed header (type, issuer, audience, issuedAt, expiresAt, size, bodyCid, nonce), an Ed25519 signature over `SHA-256(domain ‖ JCS(header))`, and a sealed body. One body limit, `MAX_LINK_BODY_BYTES` (65,536 bytes), applies to every type; a body over it has neither a short nor a full link.
- Signers: `createLink`, `deleteLink`, `prepareLinkRecord`, `signHeader` and `signDelete` take a `LinkSigner` (`{ did, sign(digest) }`), so the caller keeps its private key. `signerFromSeed` and `signerFromJwk` build one for tests and simple callers.
- Links: `buildShortLink`, `buildFullLink`, `parseLink` (strict grammar, both forms) and `resolveLink` (the full reader pipeline, an optional `validateBody` hook, and one `LinkError` class with a `code` per refusal).
- Delivery helpers: `shortShareLinkCid(href, { trustedOrigins })` gives the `c` of a short share link on one of the required `trustedOrigins` and `undefined` for any other string, including an id that is not lowercase; `DEFAULT_SHARE_ORIGINS` is the production share origin; `redactLink(text, href)` replaces a link and the key in its `k=` parameter in a text; `assertDidKeySignature(did, message, signature)` throws unless the signature, in its one canonical base64url spelling, verifies under the strict rule.
- Verification: `verifyEd25519Strict` applies one Ed25519 rule everywhere (`S < ℓ`, canonical and prime-order `A` and `R`).
- Strictness: a stored record, header or signature with an own key outside its field set (`__proto__` included) is refused before any copy is made, also on the short-link path; a `now` or date that is not a real time is refused with the `timestamp_format` `LinkError`; `isCanonicalRawCid`, exported by the package root and used by the links module, compares the string with a fresh encoding of the CID, so a trailing `=` is refused.
- The `X-Link-Record` value of a short link must be the JCS text of its parsed value (`record_not_canonical`): a repeated key, white space, another key order or a key besides `header` and `signature` is refused.
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
