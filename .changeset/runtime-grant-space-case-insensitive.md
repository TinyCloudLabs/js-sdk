---
"@tinycloud/node-sdk": patch
---

Fix runtime permission grants silently failing to match across EIP-155 address-case differences.

`TinyCloudNode.operationCovers` compared a runtime grant's `spaceId` against the requested operation's `spaceId` byte-for-byte. Stored runtime delegations (e.g. from `tc auth request --grant`, replayed on every node create) keep the EIP-55 **checksummed** address, while a space URI built by the CLI is **lowercased** — so a valid granted capability never matched and the invocation fell back to the base session, surfacing as a spurious `401 AUTH_UNAUTHORIZED` ("active session missing capability") even though `tc auth caps` showed the cap.

Ethereum addresses are case-insensitive; space comparison now lowercases ONLY the `eip155:<chain>:0x<addr>` address segment before comparing, leaving the case-sensitive space NAME byte-exact. This is the runtime-grant analogue of the CLI-layer `OPENKEY_SCOPE_MISMATCH` fix (`normalizeSpaceForCompare`).
