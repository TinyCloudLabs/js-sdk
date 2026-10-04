---
"@tinycloud/cli": patch
---

The CLI now replays stored compact-UCAN delegations under the same request-binding rule as the operations runtime: through validated activation, and only when the delegation's signed capabilities fit inside its stored `authorityRequest`. A delegation broader than its binding is refused before it is activated, so `tc kv` and `tc sql` can no longer use it either. Signed-login grants from `tc auth request --grant` and secret-read approvals replay as before, sending the node only their single `Authorization` header; a stored record with any other header shape, or one of these records that carries an `authorityRequest`, installs nothing. A new OpenKey or local grant never replaces a stored record for the same CID that carries a binding. Ordinary commands on a local-key profile now run the profile's one-time binding migration; an explicit `--private-key` override does not.

`tc auth import` of an artifact with no request (a bare portable delegation, a stored record, or an envelope without `requestId`) now validates a compact-UCAN delegation addressed to the profile's session key, and stores it bound to exactly its own signed capabilities (`unbound-import:<cid>`, with an audit note). It therefore keeps working with `tc secrets get` and MCP tools after the profile's one-time binding migration. Importing a CID that is already stored never drops or weakens its binding, and a delegation whose header is not a single string `Authorization` is refused with `INVALID_AUTH_IMPORT`.

The skill's `AUTH.md` and `REFERENCE.md` describe the bindings, the one-time migration, and how to recover a record that installs nothing.
