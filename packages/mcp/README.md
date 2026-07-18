# @tinycloud/mcp

Local stdio MCP server for delegated TinyCloud operations. It pins one
TinyCloud profile at startup, defaults to `delegate-session` posture, and never
silently falls back to owner authority.

## Requirements

- Node.js 20 or newer
- `@tinycloud/cli`
- A delegated TinyCloud profile
- A TinyCloud node running 1.6.0 or newer

## Install and configure

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

The server exposes 16 tools:

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
