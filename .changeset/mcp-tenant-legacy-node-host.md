---
"@tinycloud/mcp": patch
---

Hosted MCP tenants created before `TC_HOST` moved to `https://tee.node.tinycloud.xyz` no longer refuse every authority approval with `400 stage=auth_import code=DELEGATION_HOST_MISMATCH`. Those tenants kept `https://node.tinycloud.xyz` as the host in their stored profile. The runtime already used `TC_HOST`, but `tinycloud.auth.import` compares the stored host with it. The hosted MCP now moves a tenant whose stored host is that retired default to the configured node host the next time it loads the tenant (on `tinycloud_connect` or when it creates an approval link). It writes the profile atomically and logs one line: `[tinycloud-mcp-http] tenant node host migrated: from=https://node.tinycloud.xyz to=<TC_HOST origin>`. A tenant stored with any other host is left alone and still gets `DELEGATION_HOST_MISMATCH`.
