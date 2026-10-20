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

Claude web, iOS, Android and other remote clients connect to
`https://mcp.tinycloud.xyz/mcp` and authenticate through OpenKey OAuth. The
hosted server registers 20 tools: it adds `tinycloud_connect` and four
personal-record tools, and omits local-only `tinycloud_secrets_status` and
`tinycloud_auth_import`.
`tinycloud_connect` returns a short-lived browser approval URL on first use. Later
`authority_required` results include the same one-click approval flow for the
exact requested operation; approved delegations arrive only through that flow,
which binds them to the requesting OpenKey account and stored request.

For personal records, ask naturally: “Log my weight: 80.5 kg today.”
`tinycloud_apps_context` supplies the rules and catalog, `tinycloud_apps_read`
reads records with ETags, and `tinycloud_apps_write` creates, conditionally edits,
moves or deletes records in ordered batches of up to ten operations.
`tinycloud_apps_query` refreshes the optional fast copy and queries selected kinds.
These tools are hosted-only and share the coding-agent skill's
`xyz.tinycloud.agent-data/` records in the owner's `default` space without a
local CLI or skill installation. First use requires connect and records approval.
Records use one prefix grant with get/list/put/delete, not one grant per key.
Generic KV tools retain their exact-input scopes. The connector asks for the
owner's city once to store an IANA timezone. In Claude **Settings → Connectors →
TinyCloud**, set `tinycloud_apps_write` to **Always allow** if desired; this
does not bypass OpenKey approval.

Read fresh before an edit and supply its ETag. Put without an ETag is
create-only; stale ETags return `CHANGED`. Move requires the source ETag;
delete can also be guarded by one. Inspect every operation outcome and a
move's completed `steps` (`written`, `deleted`): an `ok` envelope can contain
partial failures. Report partial outcomes rather than replaying the batch.
`TIMEZONE_REQUIRED` requires setting the owner's timezone before writing.

Production requests 30-day grants and uses 15-minute approval links. Expired or
missing sessions return a fresh link in `error.details`; expired grants use
`authority_required`. Approvals are renewed by the owner, not automatically.
If the owner declines, stop rather than asking again in that conversation.

For larger questions, offer “a fast, searchable copy of your records” after
answering from KV when no copy is approved. It needs separate approval and is
optional; KV records remain the source of truth. The exact SQL database is
`xyz.tinycloud.agent-data.index`, with read/write/schema authority. Writes sync
the copy when authorized or mark changed kinds stale; queries rebuild stale
kinds before answering and return checked per-kind record counts.
`COPY_PARTIAL` is an `ok` result listing remaining kinds; the next query resumes.
A nonretryable `NODE_ERROR` with `error.details.reason: "copy_unavailable"`
requires node-team resolution. Answer from KV, do not retry in a loop or rename
the database to bypass the failure.

Each approved delegation is stored with the request it was checked against.
Replay verifies both compact UCAN and signed-login authority against that
binding. The binding is local profile data, not protection against someone who
can write the tenant's state directory and already holds the session key and
signed delegation.

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
default TinyCloud node is `https://tee.node.tinycloud.xyz`.
Standalone defaults are `TC_MCP_DELEGATION_EXPIRY=1h` and
`TC_MCP_APPROVAL_TTL_SECONDS=300`. Production `docker-compose.phala.yml`
explicitly overrides these to `30d` and `900`; the container command above
does not inherit the compose settings.

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

The local server exposes 19 tools. Hosted mode exposes 22: it adds
`tinycloud_connect`, `tinycloud_apps_context`, `tinycloud_apps_read`,
`tinycloud_apps_write` and `tinycloud_apps_query`, and omits
`tinycloud_secrets_status` and `tinycloud_auth_import` (local/stdio only):

- Local and authorization state: `tinycloud_status`,
  `tinycloud_auth_status`, `tinycloud_auth_capabilities`
- Exact permission flow: `tinycloud_auth_request`, `tinycloud_auth_import`
- Account discovery: `tinycloud_account_spaces_list`,
  `tinycloud_account_applications_list`
- Bounded KV CRUD: `tinycloud_kv_list`, `tinycloud_kv_get`,
  `tinycloud_kv_head`, `tinycloud_kv_put`, `tinycloud_kv_delete`
- Installed apps' knowledge (`<app_id>/knowledge/` in the `applications`
  space): `tinycloud_knowledge_list` lists the apps that have a bundle with
  their concept files; `tinycloud_knowledge_read` reads an app's index, or one
  concept with its frontmatter parsed. Read the index first and open only the
  concepts the task needs. These are not the `tinycloud_apps_*` personal-record
  tools.
- Bounded SQLite: `tinycloud_sql_schema_inspect`, `tinycloud_sql_query`,
  `tinycloud_sql_execute`
- Delegated secrets: `tinycloud_secrets_get`, `tinycloud_secrets_status`
  (the status tool is local/stdio only)

`tinycloud_secrets_status` is read-only and never signs in. It uses only the
profile's stored session and reports, without reading any value, whether each
named secret is `ready`, `pending` (with a Secret Manager `/request` setup
link), or `consent_required` (no permission request is saved). When it cannot
proceed, `error.details.recovery` names the next step: `sign_in` carries the
persistent `tc --profile <P> auth login ...` command to run in a terminal, and
`complete_migration` carries `tool: "tinycloud_auth_capabilities"`, which you
call once before retrying status.

A missing secret's `setup` is the canonical Secret Manager `/request` link
(`{url, names, scope?, owner, action: "add_secret"}`).

Results use canonical structured envelopes with `ok`, `authority_required`,
`setup_required`, or `error` status. Generic data operations plan authority for
the exact space and key, prefix, or database supplied by the caller; apps use
the records-prefix exception described above. Missing authority returns an
exact, resumable request instead of widening access.

Hosted text blocks contain the status and canonical JSON so clients that ignore
`structuredContent` can read the result. Successful `tinycloud_secrets_get`
values remain structured-only. Read-only results exceeding 100,000 characters
return a nonretryable SQL/KV size error with narrowing guidance. Writes are never
cut off by this cap, so a completed write is not misreported as a retryable failure.
Call logs contain only tool name, outcome code, duration and successful replayed
grant count—never keys, values, catalog text, SQL or parameters.

KV and SQLite HTTP authorization refusals are nonretryable structured errors:
plain 401 is `AUTH_REQUIRED`, 403 is `PERMISSION_DENIED`, and 401 naming a
validated missing capability is `PERMISSION_DENIED` rather than a request to
sign in again. Node/transport failures such as HTTP 502 remain retryable
`NODE_ERROR` (except uncertain SQL mutations, which must not be blindly retried).
The node's response text and capability metadata are not returned in MCP errors.

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

Each imported delegation is stored with the request it was checked against.
Every tool call reinstalls a stored compact-UCAN delegation only when its
signed capabilities fit inside that request, so a delegation broader than its
binding is refused before it is activated. `tc auth import` of an artifact
with no request binds the delegation to exactly its own signed capabilities.
Delegations stored by earlier releases are bound once, the same way, by the
first command that restores the profile's session; after that, a record
without a binding (from an older release or pasted into the profile) installs
nothing until it is imported again. The binding is local profile data: it does
not stop someone who can write the profile directory. See the CLI skill's
`AUTH.md` for the full rules.

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
