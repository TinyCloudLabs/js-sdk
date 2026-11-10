# @tinycloud/node-sdk

## Registry v2 resource routing

Node SDK and the Web SDK's shared Node client use owner-signed registry v2 records by default. Set `tinycloudRegistryUrl` to select a registry; isolated development may use a loopback HTTP origin.

Routing uses the complete space URI, not a short space name or a single account-wide host. Reads use that space's listed members; writes target every listed `read-write` member. Read-only members may register a session and host their listed replica, but do not receive ordinary writes. Advertised node DIDs are checked against `/info` and `/.well-known/tinycloud/node-keys` before use.

Encryption is resolved separately: descriptor reads, network creation, and decrypt requests use the signed `encryptionNode`, including its invocation audience. A data-space host does not become an encryption destination, or vice versa.

Explicit `host`, saved-profile hosts, local discovery, and new-user defaults are onboarding hints only after the reachable registry confirms genuine absence. The lookup checks v2 first, then v1 to distinguish absence from an existing v1 registration. Cold HTTP5xx, transport errors and timeouts without saved settings refuse live routing with `registry_unavailable`; neither a configured/default host nor `onNodeNotFound` may override that refusal. Low-level background lookup may still describe an offline unregistered verdict, but policy lookups do not authorize it. HTTP4xx refusals, v1-only registrations, corrupt caches, invalid responses, remembered registrations, empty registered memberships and missing encryption destinations never authorize fallback. Signed strings are validated without rewriting them.

`NodeNotRespondingError` has code `NODE_NOT_RESPONDING`. Registry refusals and node-identity mismatches remain distinct errors. Multi-node writes are not atomic: `PartialNodeWriteError` exposes `succeeded` URLs and `failed` destinations/statuses/causes so callers do not mistake incomplete writes for success.

Mixed signed grants register unchanged on the union of their listed data destinations and `encryptionNode`. Restoring a stored valid grant does not request new consent when a destination is unavailable: canonical operations preserve `NODE_NOT_RESPONDING`, `NODE_IDENTITY_MISMATCH`, and `REGISTRY_UNAVAILABLE` separately from invalid or expired authority.

Request-bound imports keep the original request/profile binding. A differing grant transport host is accepted only after validated permissions resolve through verified full-resource registry memberships; the derived destination replaces neither the saved hint nor signed bytes. Genuine no-entry still requires the original host match.

### Signed registry cache

`registryCacheStore` accepts a `RegistryCacheStore` from `@tinycloud/sdk-core`; the default is in-memory. The store keeps the exact fetched UTF-8 response text separately from `ownerKey`, `sequence` and `fetchedAt` metadata. EOA keys use the canonical EIP-55 address across wallet chains; `did:key` keys remain exact. Every read and replacement comparison reuses the canonical signed-v2 verifier.

Persistent adapters implement `get`, required `getRevision(ownerKey)`, atomic `update(ownerKey, (current, revision) => ...)`, and `delete(ownerKey, expectedRevision?, maximumSequence?)`. The callback receives the current revision under the same store lock as the entry. Conditional deletion refuses without mutation when the revision differs or a current signed entry has a higher sequence than `maximumSequence`; validate supplied bounds as non-negative safe integers. Instrumented adapters must forward both callback arguments and all deletion arguments.

Each real deletion atomically replaces the entry with `{ ownerKey, revision: previousRevision + 1, invalidated: true }`, even when already empty. Tombstones contain no signed bytes and `get` returns `undefined` for them; `getRevision` still reads their generation. Live entries may carry local `revision` metadata; legacy entries without it have revision zero. Accepted updates preserve the store's revision, not a callback-supplied value. Persist the tombstone and counter in one value/file under the existing queue or per-entry lock; never use a separate counter write. Corrupt or overflowing revisions refuse.

Routing captures the revision before network I/O and checks it under the commit lock and before cached fallback. A persisted positive revision remains known-owner evidence even without a sequence adapter; it is not a signed sequence. Only a higher verified sequence replaces signed bytes. Equal-sequence renewal requires the identical canonical signed payload; differing response formatting preserves exact old raw bytes. Failed, invalid, conflicting or lower-sequence responses never renew age. Keep `registrySequenceStore` for complete signed high-water history. Ordinary accepted-sequence persistence remains best-effort; authoritative deletion retains known-owner evidence before invalidating.

Every owner routing decision awaits a bounded registry refresh. Overlapping refreshes coalesce per owner; later decisions fetch again, without a retry loop or polling daemon. During transport errors, timeouts or HTTP 502/503/504 only, routing may use a canonically reverified cache whose `fetchedAt` age is strictly less than one hour. HTTP 500 and every other status do not authorize warm fallback. Authoritative HTTP4xx responses and fresh signed records without the required route delete cached settings while retaining known-owner evidence; later outages do not select a default for that owner.

Each caller retains registration evidence observed before joining an in-flight refresh and checks current cache/high-water state before routing. Non-replicating `restoreSession()` verifies and hydrates signed session authority locally without registry or node I/O. Later live operations still resolve fresh routing through the service graph. The first live routing decision also starts background prefetch for the canonically verified wallet owner, independently of the requested resource's owner. Web startup's hosting probe and real held-grant activation use that same boundary; local-only inspection does not. Explicitly enabled replication retains its routing and node preflight.

Restored host hints install alongside the replacement session and service graph. Subsequent public delegation preparation uses that installed hint when fresh routing permits onboarding; verified signed destinations still take precedence.

With no saved settings, an unreachable registry refuses before data requests; it does not select a default host or emit a default-host warning. Warm fallback still logs `Storage settings are unreachable; using cached settings checked less than 1 hour ago.` once per owner/client cache after selecting the verified cached route. `onRegistryFallback(reason, code?)` collects that value-free diagnostic instead of the default console warning, using `using_cached_settings`. Background refresh alone does not warn. CLI errors keep `REGISTRY_UNAVAILABLE` and explain that no settings are saved on this computer.

This is a client cache: a node that performs online registry admission still needs its own registry connectivity. It is not a whole-service-outage guarantee.

Details: TC-2481


## Signed SIWE metadata

Set `siweConfig.resources` to `urn:tinycloud:recipients:<base64url>` URI strings to include a recipients declaration in the signed SIWE. The payload uses only unpadded base64url characters (`A–Z`, `a–z`, `0–9`, `_`, `-`). Node-sdk inserts these URIs immediately before the original ReCap resource, which remains last. Ordinary sign-in, external/OpenKey preparation, and bootstrap sessions use the same insertion path; completion and session storage retain the signed message unchanged.

These resources do not add permissions. Other schemes, percent encoding, escape sequences and literal controls are not accepted in this option. The generated statement and ReCap remain unchanged; `siweConfig.statement` does not replace the generated statement. Omitting resources or passing an empty array leaves the prepared message unchanged.

## Space-hosting lifetime

Node and browser SDKs sign space-hosting delegations with an expiration one UTC calendar year after creation (February 29 becomes February 28). `EXPIRY.HOSTING_YEARS` in `@tinycloud/sdk-core` defines this tier. `siweConfig.expirationTime` can request a shorter lifetime; later values are clamped to the hosting tier. Invalid or elapsed values are refused before signing.

Hosting registration persists independently of this grant's lifetime. Existing hosted-space checks do not automatically renew the grant; normal data operations use their own active session authority.

Details: TC-2691

## `@tinycloud/node-sdk/credential-pending-store`

File-backed pending store for the email-proof flow. It keeps one file per request under `<home>/credentials/`, named by a hash of the request id. The directory is created with mode 0700 and each file with mode 0600. Permissions and ownership are re-checked on every read. Only a `home` that is itself a symlink is refused; ancestors of `home` may be symlinks, but `realpath(home)` must be owned by the current user. Unsafe files are left in place and reported as an error.

## Revoking delegations

`tinycloud.delegation/revoke` on a space is space-wide: it can revoke any delegation in that space, including other apps' grants and the owner's own sessions. Request it only for the command that needs it, with a short expiry, and don't keep it: the CLI's own fallback asks for 5 minutes and stores nothing. Never put it in a long-lived grant or an app manifest.

## Key-wrap formats

Network-key writes use `x25519-aes256gcm/v1` by default. Set `keyWrapV2: true` on `TinyCloudNode`, `TinyCloudWeb`, or `EncryptionServiceConfig` to write TCW2 wraps (`x25519-hkdf-aes256gcm/v2`). `encryptToNetwork(..., { keyWrapV2 })` overrides the service setting for one call. Named-key clients accept the same flag in their configuration and encrypt options; `createNamedKeyClient(node)` inherits the Node setting.

TCW2 uses X25519, HKDF-SHA256, and AES-256-GCM with a canonical authenticated header carrying the recipient, purpose, network, exact key path, key version, and metadata. The SDK compares inline metadata and key context to that header; node responses bind the exact requested capsule hash. Readers accept either supported response wrap format independently of the request format. Network descriptors and inline payload schema versions are unchanged; named-key envelopes retain their existing schema.

Set `requireKeyWrapV2: true` on `TinyCloudNode`, `TinyCloudWeb`, `EncryptionServiceConfig`, or a named-key client to reject incoming v1 network-key wraps. This reader policy defaults to false and is independent of `keyWrapV2`; signed receiver responses may still use v1. `createNamedKeyClient(node)` inherits the Node reader policy unless explicitly overridden. TCW2 context strings must contain well-formed Unicode; lone UTF-16 surrogates are rejected rather than replaced.

Column decryption takes an explicit expected format: `encrypted` requires the column marker and complete authenticated frame; `legacy-plaintext` preserves bytes unchanged, including a leading `0x01`. `strictEncryption` defaults to `false` and refuses explicit legacy plaintext when enabled. V1 network wraps always select `encrypted`; missing framing is never treated as plaintext.

Details: TC-2518, TC-2517

