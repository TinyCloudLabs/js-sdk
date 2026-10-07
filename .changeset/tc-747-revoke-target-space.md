---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
---

SDK Core carries an explicit target-space and command-scoped authority CID when signing CLI revocations. The node SDK preserves raw CID ReCap resources and maps root raw-CID activation failures to the CLI's CID-bound owner-space fallback; the no-options `revokeDelegation(cid)` API retains its existing behavior.
