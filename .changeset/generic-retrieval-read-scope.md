---
"@tinycloud/operations": minor
"@tinycloud/mcp": minor
---

Add explicit reusable read-only consent for selected KV prefixes and exact SQL databases in one owner space, without widening ordinary exact-key GET or HEAD approval requests.

Add complete, bounded KV and SQL retrieval through `tinycloud.read` / `tinycloud_read`, with digest-bound byte continuations, provenance, independent recipient authorization, and explicit errors for changed sources or mismatched retrieval contexts. Hosted oversized reads now point callers to the bounded retrieval path. Existing acquisition, query, and response limits remain in place.

Expose opaque KV listing continuations and return nonretryable input errors for rejected cursors, with restart guidance. Preserve handoff identity when optional SQL options are explicitly undefined. Public ChatGPT tool exposure and the native MCP service's signed capability ceiling remain unchanged.

Details: TC-1401
