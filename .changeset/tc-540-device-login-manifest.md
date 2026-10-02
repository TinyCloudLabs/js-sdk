---
"@tinycloud/cli": minor
"@tinycloud/operations": patch
---

TC-540: `tc auth login --device --manifest FILE [--expiry DUR] [--owner DID]` and `tc auth request --manifest FILE --grant --device` request exactly a manifest's permissions through OpenKey device authorization. The CLI accepts an approval only when the transaction binding, the relayed delegation and the signed SIWE recap agree, stay inside the request, and match the session key, owner, origins and expiry; capabilities the owner unchecked are reported as `declined`, and OpenKey `invalid_scope` surfaces as `SCOPE_REJECTED`. The approval prompt prints a phone-friendly link plus code and the waiter survives transient polling failures for the whole window. `--device` now requires `--manifest`, and non-interactive `auth login` no longer switches to device mode silently. A built-in `builtin:share-publishing` manifest covers bearer and addressed `tc share publish`; `tc enable share` uses it.

Port manifest-scoped first login (`auth login --manifest/--owner/--expiry` with signed-proof verification), the `tc context` command, and the packaged core `tc-cli` skill (SKILL, AUTH, REFERENCE, INSTALL, release.json) from the 0.10 line. The default host is now `https://tee.node.tinycloud.xyz`, and profile credentials (`key.json`, `session.json`, profile stores) are written 0600 in 0700 directories.
