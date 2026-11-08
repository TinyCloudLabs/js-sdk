---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
"@tinycloud/cli": patch
"@tinycloud/mcp": patch
"@tinycloud/courier": patch
---

Send only the public session key to OpenKey during sign-in.

`sdk-core` adds `publicJwk(jwk)`, re-exported by `node-sdk`: it returns only the standard public members of a JWK (`{kty, crv, x}` for Ed25519, `{kty, crv, x, y}` for EC, `{kty, n, e}` for RSA) plus `kid` when present, and throws for a key type without a public form. The OpenKey sign-in request from `prepareOpenKeySignIn()` and `signInWithOpenKey()`, `wireOpenKeyAuthorize`, the CLI's OpenKey links and handoff, the MCP approval link and Courier's approval link and `request` output now use it. Other members such as `alg` or `use` are no longer sent.

Details: TC-2582
