---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
---

SDK Core verifies signatures and exact CID binding for compact signed grants, including older grant formats. The node SDK preserves raw CID ReCap resources, maps root raw-CID activation failures to the CLI's CID-bound owner-space fallback, and resolves the current primary space for no-options `revokeDelegation(cid)`.
