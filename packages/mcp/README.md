# @tinycloud/mcp

TinyCloud MCP server for delegated operations. It supports local stdio and a
hosted Streamable HTTP resource server. Both transports use exact, revocable
TinyCloud capabilities and never silently fall back to owner authority.

## Requirements

- Node.js 20 or newer
- `@tinycloud/cli`
- A delegated TinyCloud profile
- A TinyCloud node running 1.6.0 or newer

## Install and configure

### Hosted Streamable HTTP

Remote clients connect to one HTTPS endpoint and authenticate through OpenKey
OAuth. The hosted server adds `tinycloud_connect` to the 16 canonical tools.
That tool returns a short-lived browser approval URL on first use. Later
`authority_required` results include the same one-click approval flow for the
exact requested operation.

Run the service with an encrypted persistent volume:

```bash
docker run --rm -p 3000:3000 \
  -e TC_MCP_PUBLIC_URL=https://mcp.example.com/mcp \
  -e TC_MCP_STATE_SECRET="$(openssl rand -hex 32)" \
  -v tinycloud-mcp-state:/var/lib/tinycloud-mcp \
  ghcr.io/tinycloudlabs/tinycloud-mcp:latest
```

Set `TC_MCP_OAUTH_METADATA_URL` for a self-hosted OpenKey issuer and
`TC_MCP_ALLOWED_ORIGINS` when browsers call the MCP endpoint directly. The
default TinyCloud node is `https://node.tinycloud.xyz`.

Use one service replica with the filesystem store. Multi-replica deployments
require a shared transactional state provider, which this release does not
include.

TinyCloud production uses `docker-compose.phala.yml`. The manual
`Publish hosted MCP image` workflow publishes an exact package-version image
and deploys that image to the `tinycloud-mcp` Phala CVM. Its `production`
environment requires `PHALA_CLOUD_API_KEY`, `CLOUDFLARE_API_TOKEN`, and a stable
32-byte-or-longer `TC_MCP_STATE_SECRET`.

### Local stdio

```bash
npm install --global @tinycloud/cli @tinycloud/mcp
```

Configure a local stdio server in your MCP client:

```json
{
  "mcpServers": {
    "tinycloud": {
      "command": "tinycloud-mcp",
      "args": ["--profile", "agent"]
    }
  }
}
```

The selected profile is fixed for the life of the process. Restart the server
to select another profile.

## Tools

The local server exposes 16 tools; hosted mode adds `tinycloud_connect`:

- Local and authorization state: `tinycloud_status`,
  `tinycloud_auth_status`, `tinycloud_auth_capabilities`
- Exact permission flow: `tinycloud_auth_request`, `tinycloud_auth_import`
- Account discovery: `tinycloud_account_spaces_list`,
  `tinycloud_account_applications_list`
- Bounded KV CRUD: `tinycloud_kv_list`, `tinycloud_kv_get`,
  `tinycloud_kv_head`, `tinycloud_kv_put`, `tinycloud_kv_delete`
- Bounded SQLite: `tinycloud_sql_schema_inspect`, `tinycloud_sql_query`,
  `tinycloud_sql_execute`
- Delegated secrets: `tinycloud_secrets_get`

Results use canonical structured envelopes with `ok`, `authority_required`,
`setup_required`, or `error` status. Data operations plan authority for the
exact space and key, prefix, or database supplied by the caller. Missing
authority returns an exact, resumable request instead of widening access.

KV values support text, JSON, and lossless base64 content. Conditional replace
and delete use the strong ETag returned by `tinycloud_kv_head`. SQLite queries
are read-only and bounded; SQL execution accepts one parameterized `INSERT`,
`UPDATE`, or `DELETE` and requires explicit acknowledgement that the delegated
SQL write capability is database-wide.

## Delegate bootstrap

A new `delegate-session` profile has a key but no TinyCloud authority. Complete
the one-time bootstrap flow before starting MCP:

1. Create an exact request with `tc auth request --cap ...`.
2. Have the owner grant that request.
3. Import the returned delegation with `tc auth import`.

After bootstrap, MCP tools can create exact permission requests and import the
request-bound delegations. Requests and imports persist, so approval and retry
can happen in separate processes.

Owner-profile data execution is disabled by default. It requires both an
explicit owner profile and `--allow-owner-profile`.

## Documentation

- [TinyCloud MCP setup and tool reference](https://docs.tinycloud.xyz/cli/mcp)
- [Access and explore my TinyCloud](https://docs.tinycloud.xyz/guides/access-and-explore-my-tinycloud)
- [Agent-readable documentation index](https://docs.tinycloud.xyz/llms.txt)

Secret values are excluded from TinyCloud text output, logs, errors, request
files, delegation files, and generated artifacts. MCP hosts may retain
structured tool results in their own transcripts, so use a client and retention
policy appropriate for secrets.
