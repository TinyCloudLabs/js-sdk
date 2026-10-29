---
"@tinycloud/cli": minor
"@tinycloud/mcp": patch
---

Add explicit owner-only `feed export` for lossless KV and operator-supplied sidecar bytes. Preserve full source keys, base64 bytes, SHA-256, matching strong ETags, tombstones, and opaque change-feed cursor/source/authority metadata. Publish a complete snapshot only after an empty same-scope final tail, using durable exclusive `0600` output. Normal command output contains only a safe receipt, not raw snapshot contents. Export does not classify or restore records.

Regenerate the MCP skill coverage block for the new legacy CLI registration; no MCP operation is added.

Details: TC-2209
