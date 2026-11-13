---
"@tinycloud/operations": patch
"@tinycloud/mcp": patch
---

Hosted MCP approval links now pass their configured public origin to OpenKey. With the matching OpenKey API/web update, the prepared SIWE and consent label identify TinyCloud MCP (or the actual custom host), not TinyCloud CLI. This remains caller-reported attribution, not verified app identity. Shared approval reasons identify the TinyCloud connector rather than Claude and describe each scope's actual actions.

Generic personal-app change grants retain catalog-root get/list and app-folder CRUD, but discovery get/put is limited to `xyz.tinycloud.tinyapps.catalog/<app>/entry`. Sibling entries require separate authority. No-app discovery and read-only requests do not add catalog writes; Health Log and Recipes retain their dedicated scopes.

The exported `TC_APPS_DISCOVERY_ACTIONS` broad-write constant is removed. Consumers must use read-only discovery permissions and exact app-entry permissions instead. Previously signed broad grants are not narrowed or revoked by this update: revoke them or let them expire, then approve the narrower request. Deploy matching OpenKey API/web support before the MCP update; this changeset performs no deployment or grant revocation.

Details: TC-2416, TC-2526
