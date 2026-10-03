---
"@tinycloud/cli": patch
"@tinycloud/node-sdk": patch
---

TC-599: Scoped OpenKey login can grant an agent read access to named secrets, and the secrets commands are safe to run headless.

- `auth login --manifest` keeps raw `tinycloud.encryption` network entries in the `encryption` pseudo-space (never in the manifest's space), so the Secret Manager `secrets: { NAME: true }` shape passes first-login validation; the decrypt network uses the EIP-55-checksummed recorded owner or `--owner` (`OWNER_DID_UNKNOWN` otherwise), never the session `did:key`.
- Every scoped login (browser, paste, device) requests `tinycloud.capabilities/read` on the space root when the manifest lacks it. A signed decrypt nested inside the owner's space is not raw authority: it is reported in `declined`, omitted from saved permissions so a later valid raw renewal is not blocked, and accompanied by an old-OpenKey warning. Foreign-owner decrypt grants are refused; device login refuses encryption and secrets-space manifests up front.
- Browser `auth request --grant` and secret-read permission escalation verify the owner's signed OpenKey proof against the profile session key, requested space, scope and expiry. Only signed effective permissions are activated and persisted; old nested decrypt, foreign-owner, broadened or missing proof is refused before storage, and activation failure leaves local grants unchanged.
- `auth login --paste` accepts a final code line without a newline and fails with `PASTE_CODE_MISSING` (exit 3, naming the approval URL) when stdin ends without a code.
- `secrets get -o FILE` validates the destination and its existing directory before fetching secret bytes, syncs a new 0600 inode, and atomically replaces the destination. A best-effort parent-directory sync follows replacement without turning a completed write into an error. Symlinks, non-regular destinations, and absent parents are refused without unsafe fallback; filesystem output failures identify the destination without leaking the temporary filename.
- With no TTY on stdin or stderr, `secrets get|list|put|delete` on an OpenKey profile lacking the grant fails with `PERMISSION_DENIED` (exit 5) and a scoped paste-login hint. A missing or real signed expired session fails with `AUTH_REQUIRED` (exit 3) before the canonical get operation or an unscoped browser refresh. Redirecting stdout alone still permits owner approval through stderr and terminal stdin.
- node-sdk: a decrypt refused with HTTP 401/403 is reported as missing decrypt authority on the invoked network, never on a response-supplied resource or action.
- node-sdk keeps an owner's space-nested encryption ReCap distinct from a raw network grant when restoring sessions, checking runtime permissions, and deriving further delegations.
