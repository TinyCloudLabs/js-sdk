---
"@tinycloud/cli": patch
"@tinycloud/node-sdk": patch
---

TC-599: Scoped OpenKey login can grant an agent read access to named secrets, and the secrets commands are safe to run headless.

- `auth login --manifest` keeps raw `tinycloud.encryption` network entries in the `encryption` pseudo-space (never in the manifest's space), so the Secret Manager `secrets: { NAME: true }` shape passes first-login validation; the decrypt network uses the profile's recorded owner or `--owner` (`OWNER_DID_UNKNOWN` otherwise), never the session `did:key`.
- Every scoped login (browser, paste, device) requests `tinycloud.capabilities/read` on the space root when the manifest lacks it; the signed raw decrypt entry is verified, and an unchecked one is reported in `declined`.
- `auth login --paste` accepts a final code line without a newline and fails with `PASTE_CODE_MISSING` (exit 3, naming the approval URL) when stdin ends without a code.
- `secrets get -o FILE` writes the file owner-only (0600).
- Without a terminal, `secrets get|list|put|delete` on an OpenKey profile lacking the grant fails with `PERMISSION_DENIED` (exit 5) and a hint naming the scoped paste login, instead of waiting on a browser approval.
- node-sdk: a decrypt refused with HTTP 401/403 and no structured hint is reported as missing decrypt authority on the requested network, not as an undecryptable secret.
