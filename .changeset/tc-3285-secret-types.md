---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/cli": minor
---

A secret can carry an optional type: `secret` (the default), `totp`, `username` or `password`. `secrets.put(name, value, { type })` stores the type inside the encrypted secret. The new `secrets.getEntry(name)` returns `{ value, type, createdAt, updatedAt }`; a secret with no stored type, or with a type the client doesn't know, reads as `secret`.

`secrets.get` is unchanged, and older clients still read typed secrets, since they only need `value`. Storing `secret`, or no type, writes the same payload as before.

`@tinycloud/sdk-services/secrets/totp` (not exported from the package root) adds `parseTotpSeed` (an `otpauth://totp/` link or a bare base32 seed), `generateTotp` (RFC 6238, SHA1/SHA256/SHA512) and `totpSecondsRemaining`.

`tinycloud secrets put --type <secret|totp|username|password>` sets the type. For `totp`, the value must be a valid seed: an `otpauth://totp/` link or a bare base32 seed.

Details: TC-3285
