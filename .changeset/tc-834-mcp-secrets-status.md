---
"@tinycloud/mcp": minor
---

Add `tinycloud_secrets_status` (`tinycloud.secrets.status@1`) for local/stdio MCP only; the hosted server does not register it. It is read-only (`readOnlyHint`, `idempotentHint`, `openWorldHint`) and never signs in: it uses the profile's stored session and reports each named secret as `ready`, `pending`, or `consent_required` without saving a permission request.

Missing-secret `setup` is now the canonical Secret Manager `/request` link (`{url, names, scope?, owner, action: "add_secret"}`) instead of the old setup link. A `complete_migration` recovery in `error.details.recovery` now carries `tool: "tinycloud_auth_capabilities"`, taken from the binding table.

Tool bindings gain an optional `surfaces` field (`"local"` / `"hosted"`, default both), and `McpStartupSelection` gains a required `surface`; `registerTinyCloudTools` skips bindings not on that surface. Generated `mcp-facts.json` lists each tool's surfaces.

**Breaks:** direct callers of `registerTinyCloudTools` must pass `surface`; clients that parsed the old setup link shape; the local server now lists 17 tools.
