---
"@tinycloud/cli": patch
---

Fix `tc kv` and `tc sql` failing with `Missing private key parameter in JWK` after an OpenKey login. The OpenKey delegation flow sends only the public JWK (no `d`) to OpenKey, and the public-only JWK that OpenKey echoes back was being persisted verbatim to `session.json`, shadowing the full keypair in `key.json` whenever the SDK reconstructed the WASM signer. Two-pronged fix: (1) on read, `sdk.ts` falls back to `key.json` whenever `session.jwk` lacks the `d` parameter, and (2) on write, `refreshOpenKeySession` merges `d` from `key.json` into the persisted session JWK so future invocations don't hit the same path. `tc auth status` and `tc secrets get` were unaffected because neither hits the WASM signer in this code path.

Affected users on existing installs can unblock without re-authenticating by jq-merging `key.json`'s `d` into `session.json`'s `.jwk` field.
