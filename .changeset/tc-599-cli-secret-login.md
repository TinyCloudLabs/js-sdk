---
"@tinycloud/cli": patch
"@tinycloud/node-sdk": patch
---

TC-599: Scoped OpenKey login can grant an agent read access to named secrets, and the secrets commands are safe to run headless.

- `auth login --manifest` keeps raw `tinycloud.encryption` network entries in the `encryption` pseudo-space (never in the manifest's space), so the Secret Manager `secrets: { NAME: true }` shape passes first-login validation; the decrypt network uses the EIP-55-checksummed recorded owner or `--owner` (`OWNER_DID_UNKNOWN` otherwise), never the session `did:key`.
- Every scoped login (browser, paste, device) requests `tinycloud.capabilities/read` on the space root when the manifest lacks it. A signed decrypt nested inside the owner space is not a raw grant: it is reported in `declined` with an old-OpenKey warning. Foreign-owner decrypt grants are refused; device login refuses encryption and secrets-space manifests up front.
- `auth login --paste` accepts a final code line without a newline and fails with `PASTE_CODE_MISSING` (exit 3, naming the approval URL) when stdin ends without a code.
- `secrets get -o FILE` atomically replaces a regular file with a fresh 0600 inode, leaving existing readers untouched; symlinks and non-regular destinations (including `/dev/null` and `/dev/stdout`) fail with `INVALID_ARGUMENT`.
- With no TTY on stdin or stderr, `secrets get|list|put|delete` on an OpenKey profile lacking the grant fails with `PERMISSION_DENIED` (exit 5) and a scoped paste-login hint. A missing or expired session fails with `AUTH_REQUIRED` (exit 3) before an unscoped browser refresh. Redirecting stdout alone still permits owner approval.
- node-sdk: a decrypt refused with HTTP 401/403 is reported as missing decrypt authority on the invoked network, never on a response-supplied resource or action.
