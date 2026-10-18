---
"@tinycloud/sdk-services": minor
"@tinycloud/node-sdk": patch
---

Vault compare-and-swap and opt-in address binding (TC-1432). Everything is additive; existing reads and writes behave as before.

- `VaultEntry.etag`: the node's strong ETag of the stored envelope. `readNetworkEncrypted` always returns it; `vault.get` returns it only with `source: "network"`, never from a replica (a replica can serve a stale etag). Network-encrypted vaults only.
- `VaultPutOptions.ifMatch`: write only while the stored envelope still has that etag, passed exactly as read (quotes included); it cannot be combined with `ifNoneMatch`. A failed `ifMatch` write has its own code instead of `STORAGE_ERROR`: `ETAG_MISMATCH` (412, including a deleted or never-written key; re-read and retry), `INVALID_ETAG` (a weak, unquoted or otherwise malformed etag, refused locally or by the node's 400; never retry), `OUTCOME_UNKNOWN` (500 `outcome_unknown`, or a connection that failed with no response: the write may have been applied, so re-read before retrying and sign a fresh request) and `NODE_BUSY` (503, nothing written). Writes without `ifMatch` keep their current error mapping. `readSecret` maps the new `aad_mismatch` status to `read_failed`.
- `VaultGetOptions.expectAad` (default off): refuse an envelope whose AAD is not `tinycloud.vault:<spaceId>:<key>` for the vault's own space and key. The space id is compared after lowercasing its EVM addresses, so a checksummed and a lowercase spelling are the same space. A mismatch, including an envelope written with no AAD, fails with `AAD_MISMATCH` (`get`) or `{ status: "aad_mismatch" }` (`readNetworkEncrypted`) before any decrypt request. This rejects a ciphertext copied to another key; it does not stop a freshly encrypted forgery. `getShared` is unchanged.
