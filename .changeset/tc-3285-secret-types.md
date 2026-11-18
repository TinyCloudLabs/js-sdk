---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/cli": minor
---

A secret can carry an optional type: `secret` (the default), `totp`, `username` or `password`. `secrets.put(name, value, { type })` stores it inside the encrypted secret, and the new `secrets.getEntry(name)` returns `{ value, type, createdAt, updatedAt }`; a secret with no stored type, or one a client does not know, reads as `secret`. `secrets.get` is unchanged, and older clients still read typed secrets (they only need `value`). Storing `secret`, or no type, writes the same payload as before. `@tinycloud/sdk-services/secrets/totp` (not exported from the package root) adds `parseTotpSeed` (an `otpauth://totp/` link, or a bare base32 seed), `generateTotp` (RFC 6238, SHA1/SHA256/SHA512) and `totpSecondsRemaining`. `tinycloud secrets put --type <secret|totp|username|password>` sets the type, and a `totp` secret must be a usable seed.

Details: TC-3285
