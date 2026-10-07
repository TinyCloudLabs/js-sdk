---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
---

SDK Core verifies signatures and exact CID binding for compact signed grants, including older grant formats. The node SDK preserves raw CID ReCap resources when selecting revoke control proofs.
