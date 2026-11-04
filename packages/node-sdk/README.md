# @tinycloud/node-sdk

## Registry v2 resource routing

Node SDK and the Web SDK's shared Node client use owner-signed registry v2 records by default. Set `tinycloudRegistryUrl` to select a registry; isolated development may use a loopback HTTP origin.

Routing uses the complete space URI, not a short space name or a single account-wide host. Reads use that space's listed members; writes target every listed `read-write` member. Read-only members may register a session and host their listed replica, but do not receive ordinary writes. Advertised node DIDs are checked against `/info` and `/.well-known/tinycloud/node-keys` before use.

Encryption is resolved separately: descriptor reads, network creation, and decrypt requests use the signed `encryptionNode`, including its invocation audience. A data-space host does not become an encryption destination, or vice versa.

Explicit `host`, saved-profile hosts, local discovery, and new-user defaults are onboarding hints. The lookup checks v2 first, then v1 to distinguish absence from an existing v1 registration. Cold HTTP5xx, transport errors and timeouts without cached or remembered registration retain configured/default-host compatibility, including direct Core callers without a cache adapter; the verdict is marked `offline`, not genuine registry absence. HTTP4xx refusals, v1-only registrations, corrupt caches, invalid responses, remembered registrations, empty registered memberships and missing encryption destinations never authorize fallback. Signed strings are validated without rewriting them.

`NodeNotRespondingError` has code `NODE_NOT_RESPONDING`. Registry refusals and node-identity mismatches remain distinct errors. Multi-node writes are not atomic: `PartialNodeWriteError` exposes `succeeded` URLs and `failed` destinations/statuses/causes so callers do not mistake incomplete writes for success.

Mixed signed grants register unchanged on the union of their listed data destinations and `encryptionNode`. Restoring a stored valid grant does not request new consent when a destination is unavailable: canonical operations preserve `NODE_NOT_RESPONDING`, `NODE_IDENTITY_MISMATCH`, and `REGISTRY_UNAVAILABLE` separately from invalid or expired authority.

Request-bound imports keep the original request/profile binding. A differing grant transport host is accepted only after validated permissions resolve through verified full-resource registry memberships; the derived destination replaces neither the saved hint nor signed bytes. Genuine no-entry still requires the original host match.

### Signed registry cache

`registryCacheStore` accepts a `RegistryCacheStore` from `@tinycloud/sdk-core`; the default is in-memory. The store keeps the exact fetched UTF-8 response text separately from `ownerKey`, `sequence` and `fetchedAt` metadata. EOA keys use the canonical EIP-55 address across wallet chains; `did:key` keys remain exact. Every read and replacement comparison reuses the canonical signed-v2 verifier.

Persistent adapters implement `get` and an atomic `update` callback. Serialize the entire callback/read/compare/write across processes or tabs. Only a strictly higher verified sequence replaces an entry; equal sequences do not change its bytes or fetch age. Cache read errors and invalid cached entries are refusals, not missing records. Keep `registrySequenceStore` when migrating high-water state: a verified cache read establishes that history before refresh, so later cache loss is not fresh-device absence. Profile and browser sequence adapters retain the highest seen sequence in memory when persistence fails, without masking corrupt or unreadable stored state.

Warm routing returns the verified cache without waiting for network refresh. Sign-in/restore starts an early refresh for the authenticated owner; validated held delegations add owners derived from their signed resources. Refreshes coalesce per owner while in flight, switch only to newer entries, and add no retry loop or polling daemon.

Actual cold fallback logs `registry unavailable; using the default node` once per owner/client cache. `onRegistryFallback(reason)` can collect that value-free diagnostic instead of the default console warning. Background lookups do not warn unless a fallback route is actually selected; warm verified-cache routing never warns or falls back.

This is a client cache: a node that performs online registry admission still needs its own registry connectivity. It is not a whole-service-outage guarantee.

Details: TC-2481


## Signed SIWE metadata

Set `siweConfig.resources` to `urn:tinycloud:recipients:<base64url>` URI strings to include a recipients declaration in the signed SIWE. The payload uses only unpadded base64url characters (`A–Z`, `a–z`, `0–9`, `_`, `-`). Node-sdk inserts these URIs immediately before the original ReCap resource, which remains last. Ordinary sign-in, external/OpenKey preparation, and bootstrap sessions use the same insertion path; completion and session storage retain the signed message unchanged.

These resources do not add permissions. Other schemes, percent encoding, escape sequences and literal controls are not accepted in this option. The generated statement and ReCap remain unchanged; `siweConfig.statement` does not replace the generated statement. Omitting resources or passing an empty array leaves the prepared message unchanged.

## `@tinycloud/node-sdk/credential-pending-store`

File-backed pending store for the email-proof flow. It keeps one file per request under `<home>/credentials/`, named by a hash of the request id. The directory is created with mode 0700 and each file with mode 0600. Permissions and ownership are re-checked on every read. Only a `home` that is itself a symlink is refused; ancestors of `home` may be symlinks, but `realpath(home)` must be owned by the current user. Unsafe files are left in place and reported as an error.

## Revoking delegations

`tinycloud.delegation/revoke` on a space is space-wide: it can revoke any delegation in that space, including other apps' grants and the owner's own sessions. Request it only for the command that needs it, with a short expiry, and don't keep it: the CLI's own fallback asks for 5 minutes and stores nothing. Never put it in a long-lived grant or an app manifest.

