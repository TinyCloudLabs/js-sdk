---
"@tinycloud/operations": patch
"@tinycloud/mcp": patch
---

After an approval is revoked at the node, the hosted connector asks for a new one again. Since node 1.25.17 a revocation refusal is `401 {"code": "delegation_revoked", "error": "delegation-revoked: <cid>"}`. The connector understood only the older plain-text body, so a revoked approval looked like an unexplained 401: tools answered `AUTH_REQUIRED` with no approval link, and once the connection approval was revoked `tinycloud_connect` answered "TinyCloud is unavailable" for good.

`nodeRevocationOf` and `isRevokedGrantRefusal` now read the refusal text from that exact envelope as well as from a plain body, and `nodeRevocationOf` also classifies the SQL service's 401. A revoked per-request approval (records, the searchable copy, a SQL database) is dropped and requested again with `authority_required`, as a missing one is; a revoked connection approval starts a fresh connection approval. The CLI says a grant was revoked for the new body too.

Plain-text refusals, every other 401, and the results of approvals that are still valid are unchanged. No tool name, schema, description or annotation changes.

Details: TC-1627, TC-2381
