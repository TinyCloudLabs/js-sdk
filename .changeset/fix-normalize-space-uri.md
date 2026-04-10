---
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-services": patch
---

fix(sdk-core): normalize space URI in recap parse for derivability check

The Rust WASM `parseRecapFromSiwe` returns `space` as the full recap target
URI (`tinycloud:pkh:eip155:{chainId}:{address}:{name}`), while manifest
permissions and backend-advertised permissions use the short `{name}` form
(e.g. `"default"`). `isCapabilitySubset` was doing strict string comparison
on `space`, so mixing the two forms always failed — `delegateTo` would throw
`PermissionNotInManifestError` even when the session recap covered every
requested capability.

This broke end-to-end manifest-driven sign-in in the listen app, where the
session SIWE was signed correctly with the union of all manifest abilities
but `delegateTo(backendDID, info.permissions)` still failed on the subset
check because `"tinycloud:pkh:eip155:1:0xd559...:default"` and `"default"`
didn't match as strings.

Fix: add a `normalizeSpace` helper that extracts the trailing name segment
from a `tinycloud:` URI. Apply it in `parseRecapCapabilities` (so the output
is always in short-name form) and defensively in `isCapabilitySubset` on
both sides (so callers passing either form work transparently).
