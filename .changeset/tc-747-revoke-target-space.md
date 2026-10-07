---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
---

SDK Core verifies signatures and exact CID binding for compact signed grants, including older grant formats. The node SDK preserves raw CID ReCap resources and reports the host's missing-parent rejection so the CLI can use a CID-bound owner-space fallback.
