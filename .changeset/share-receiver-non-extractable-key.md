---
"@tinycloud/web-sdk": patch
---

Accountless share receivers use a non-extractable WebCrypto Ed25519 signing key. Its handle is kept in IndexedDB (database `tinycloud.share.receiver-keys`, one key per origin, reused for at most one hour), so a reload keeps working. Where the handle cannot be kept, or the browser lacks WebCrypto Ed25519, the key is held in page memory only and a reload asks the recipient to verify their email again. Receiver sessions stored by earlier versions are removed together with their credentials, and the recipient verifies again. `forgetShareReceiverSession(origin)` removes the key and its credentials.

Changes for callers: `ShareReceiverIdentity.custody` is now `"persistent" | "memory"` instead of `"session"`; `ShareReceiverSession` adds `custody` and `expiresAt`; `createOrRestoreShareReceiverSession` takes an optional third `options` argument; `ShareReceiverServiceOptions` accepts `indexedDB`.
