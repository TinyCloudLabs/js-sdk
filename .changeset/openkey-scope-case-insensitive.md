---
"@tinycloud/cli": patch
---

Fix `OPENKEY_SCOPE_MISMATCH` on `tc auth request --grant` for OpenKey profiles, and batch multiple `--cap` on one space into a single OpenKey round-trip.

The CLI compared the space the OpenKey node returned against the space it built for the request byte-for-byte. OpenKey returns the EIP-55 **checksummed** eip155 address (`0xd559CCd9...dE93cf412`) while the CLI builds the **lowercase** form, so a grant for a valid space spuriously failed with `OPENKEY_SCOPE_MISMATCH`. Ethereum addresses are case-insensitive; space comparison now normalizes (lowercases) the address segment on both sides.

The same normalization is applied when grouping requested caps by space, so multiple `--cap` for the same space — even if one is typed checksummed and another lowercase — batch into a single OpenKey browser round-trip instead of one per casing.
