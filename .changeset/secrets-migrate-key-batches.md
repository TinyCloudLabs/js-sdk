---
"@tinycloud/cli": patch
---

`tc secrets migrate` splits the per-secret key approval so each signed request fits the node's header limit. Before asking, it sends one `GET /version` with a padding header to the node that will activate the keys. If that is refused as too large, it halves the size up to three times, then falls back to a size that fits a 32 KiB header. On a node with large header buffers, 140 keys are still one approval. The JSON output and a stderr line report how many key approvals the run needs and how large each may be.

Details: TC-4248
