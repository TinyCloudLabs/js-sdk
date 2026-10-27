# @tinycloud/mcp

TinyCloud MCP server for delegated operations. The canonical remote connection
is the hosted Streamable HTTP endpoint `https://mcp.tinycloud.xyz/mcp`, using
OpenKey OAuth. Local stdio is the alternative when the client and TinyCloud
runtime are on the same machine.

For Claude, add the hosted URL as a remote MCP connector and complete OpenKey
OAuth. ChatGPT users can add `https://mcp.tinycloud.xyz/mcp` directly as a
custom MCP server; Developer Mode is not required first. Availability depends
on the ChatGPT plan and workspace settings. Follow
[OpenAI's custom MCP connection guide](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).

## Hosted Streamable HTTP

Use `https://mcp.tinycloud.xyz/mcp` in Claude's remote MCP connector and
complete OpenKey OAuth. Other remote MCP clients may use the endpoint when they
support Streamable HTTP and OAuth.

## Local stdio requirements

- Node.js 20 or newer
- `@tinycloud/cli`
- A delegated TinyCloud profile

## Hosted personal-record behavior

Context can persist an IANA timezone; query can overwrite or rebuild derived
data. Both therefore advertise `readOnlyHint: false` and
`destructiveHint: true`. Private personal-record operations advertise
`openWorldHint: false`; this is not a claim that the hosted service cannot see
plaintext. Use these tools only for requested personal-record tasks, not
credentials, payment-card data, government identifiers or protected health
information. Respect declined approval and the client's destructive-action
confirmation flow. Ask for an IANA timezone, not a city or precise location.


## Install and configure

### Hosted Streamable HTTP

Claude web, iOS, Android and other remote clients connect to
`https://mcp.tinycloud.xyz/mcp` and authenticate through OpenKey OAuth. The
hosted server registers 22 tools: it adds `tinycloud_connect` and four
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
Generic KV tools retain their exact-input scopes. The connector asks for an
IANA timezone once, not the owner's city or precise location. In Claude
**Settings → Connectors → TinyCloud**, set `tinycloud_apps_write` to
**Always allow** if desired; this does not bypass OpenKey approval.

Read fresh before an edit and supply its ETag. Put without an ETag is
create-only; stale ETags return `CHANGED`. Move requires the source ETag;
delete can also be guarded by one. Inspect every operation outcome and a
move's completed `steps` (`written`, `deleted`): an `ok` envelope can contain
partial failures. Report partial outcomes rather than replaying the batch.
`TIMEZONE_REQUIRED` requires setting the owner's timezone before writing.

Production requests 30-day grants and uses 15-minute approval links. Expired or
missing sessions return a fresh link in `error.details`; expired grants use
`authority_required`. Approvals are renewed by the owner, not automatically.

The hosted server checks the account approval with the node when a client
connects or calls an authenticated tool. Successful checks are cached for up
to 30 seconds. A node response identifying a withdrawn account approval starts
a fresh connection approval; one identifying a withdrawn per-request grant
renews only that grant. Other node responses keep stored approvals available for
tool calls. `tinycloud_connect` reports `connected: true` only after a positive
check; when the node cannot confirm the account, it reports `connected: false`
without an approval URL and the caller retries shortly.
The account's delegate key stays in place while the owner signs new permissions
through the usual OpenKey approval flow.

HTTP integration tests cover approval renewal with an in-process node by
default. The additional local-node case uses a v1.21.0 node binary when
`TC_MCP_TEST_NODE` is set to its absolute path; otherwise that case is skipped.
The test starts and stops its own node process.

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
  -e TC_MCP_INTROSPECTION_URL=<introspection endpoint> \
  -e TC_MCP_INTROSPECTION_CLIENT_ID=<client id> \
  -e TC_MCP_INTROSPECTION_CLIENT_SECRET=<client secret> \
  -v tinycloud-mcp-state:/var/lib/tinycloud-mcp \
  ghcr.io/tinycloudlabs/tinycloud-mcp:latest
```

Set `TC_MCP_OAUTH_METADATA_URL` for a self-hosted OpenKey issuer and
`TC_MCP_ALLOWED_ORIGINS` when browsers call the MCP endpoint directly. The
default TinyCloud node is `https://tee.node.tinycloud.xyz`.
The MCP server asks OpenKey's resource-server token introspection endpoint
(RFC 7662) about each access token before serving a call.
`TC_MCP_INTROSPECTION_URL` (the endpoint; HTTPS outside localhost),
`TC_MCP_INTROSPECTION_CLIENT_ID` and `TC_MCP_INTROSPECTION_CLIENT_SECRET` (a
registered confidential OpenKey client) are required, and the server does not
start without them. The OAuth metadata's `introspection_endpoint` is not used.
`TC_MCP_INTROSPECTION_AUTH_METHOD` is `basic` (default, `client_secret_basic`)
or `post` (`client_secret_post`). Only a 200 answer with `active: true` is
active, and only when its `sub` and `client_id` equal the verified token's and
its `aud` is a non-empty subset of the token's audiences that includes this
server's resource URL; any other `active: true` answer is treated like an
inactive one. A 200 answer with `active: false` is answered with 401
`invalid_token` and kept for that token. An active answer is reused for 30
seconds. A 401 from the endpoint (`invalid_client`) is logged once and refused
with 500 `server_error`. If OpenKey cannot be reached or answers otherwise
(429, 5xx, timeout), a call is served only when OpenKey itself answered that
same token active to this server, and only until the token expires; every other
call is answered with 500 `server_error`.

The account owner can see the hosted MCP's delegation, and revoke it, on the
account site at https://account.tinycloud.xyz/delegations.

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

The workflow fails, before building or deploying, unless the `tinycloud-mcp` CVM
runs the production OS image pinned in `PHALA_OS_IMAGE` / `PHALA_OS_IMAGE_HASH`
(`dstack-0.5.12`), or a dev image whose hash is listed in
`.github/scripts/phala-dev-os-allowlist.txt` (today only `dstack-dev-0.5.12`) and
that passes a fresh check in the same job: `download.dstack.org` serves
`mr_<hash>.tar.gz`, and `sha256sum sha256sum.txt` of the extracted archive equals
`<hash>`, and every file it lists matches (`sha256sum -c`). An unknown dev hash,
a missing field, a failed fetch or a hash mismatch
fails closed. The allowlist is changed only by a reviewed PR. The logic is
`.github/scripts/phala-os-guard.sh`, tested by
`.github/scripts/test-phala-os-guard.sh` (the preflight job runs it first). The
workflow checks again after the deploy. It never changes the OS. If the check
fails, set the OS by hand and re-run:
`phala api -X PATCH /cvms/<id>/os-image -F os_image_name=dstack-0.5.12`.

### Post-deploy knowledge smoke

After the `mcp-image.yml` deploy of `tinycloud-mcp` is live, QA runs the
repo-kept script with throwaway E only (never a personal account). Clarissa's
verified `.address-E` must already exist; both files must be owned by the
current user, mode `0600`, and resolve under `~/scratch/`.

```sh
export TC_QA_PASSKEY_FILE=\"$HOME/scratch/tc1384/qa/.passkey-E.json\"
export TC_QA_EXPECTED_ADDRESS_FILE=\"$HOME/scratch/tc1384/qa/.address-E\"
export TC_QA_EXPECTED_ADDRESS_PREFIX=0x889E
export TC_QA_PLAYWRIGHT_MODULE=\"$HOME/scratch/openkey-smoke/node_modules/playwright\"
CHROME_PATH=\"$HOME/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome\" node scripts/hosted-mcp-smoke.mjs --dry-run
CHROME_PATH=\"$HOME/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome\" node scripts/hosted-mcp-smoke.mjs --expect-apps 1 --require-read
```

Run from the js-sdk repository root after the deploy lead confirms production
is live. `--base-url` defaults to `https://mcp.tinycloud.xyz` (HTTP only for
localhost). Omit `--expect-apps` when no sample-app knowledge is installed;
the empty/no-grant case is marked `PASS-WITH-NOTE` because read was not
exercised. `--expect-apps N` requires at least N apps; `--require-read` fails
instead of accepting an unexercised read. With an app, the script reads its
first concept or its index. It verifies the full signed-in owner address
against Clarissa's file before any MCP tool call, the complete read-only
knowledge descriptions, response shapes, and OAuth cleanup. It prints only
counts and PASS/FAIL/PASS-WITH-NOTE lines. Test offline:
`node --test scripts/hosted-mcp-smoke.test.mjs`.

One run holds an atomically published per-QA-account lock (including cleanup)
in the system temp directory. `TC_QA_LOCK_DIR` overrides that directory for
isolated offline tests; stale holders are checked against PID, Linux process
start time, and their recorded deadline. `--timeout-s` defaults to 300
seconds, then interrupts work, attempts bounded cleanup, and exits.
SIGINT/SIGTERM use the same cleanup.
Exit codes: `0` pass (including explicit notes), `1` assertion/cleanup fail,
`2` invalid options/config or unavailable lock directory (one-line error
with its directory name only), `3` another run holds the lock, `4` deadline,
`130` SIGINT, `143` SIGTERM.

Cleanup drains in-flight OAuth registration/token exchange responses for up
to five seconds before deleting the dynamic client and revoking the token.
An unknown issuance outcome, including a malformed registration response, is
a cleanup failure, never reported as an absent or confirmed client. A missing
revocation endpoint is a failure unless `--allow-unrevoked` is explicitly
supplied; that mode reports the outstanding token. A client without
registration management is reported as outstanding. Hosted
TinyCloud delegations themselves have **no MCP-side revoke route** (TC-1156);
they expire on the server's configured lifetime. OAuth revocation does not
revoke them.

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

MCP advertises JSON Schema 2020-12 inputs and results, compatible with the
official v2 client's default validator. The shared operations catalog remains
Draft-07 for non-MCP consumers; MCP projects its equivalent schemas without
modifying that catalog or requiring a client-side validator override.

Results use canonical structured envelopes with `ok`, `authority_required`,
`setup_required`, or `error` status. Generic data operations plan authority for
the exact space and key, prefix, or database supplied by the caller; apps use
the records-prefix exception described above. Missing authority returns an
exact, resumable request instead of widening access.

Hosted text blocks contain the status and canonical JSON so clients that ignore
`structuredContent` can read the result. Successful `tinycloud_secrets_get`
values remain structured-only. Read-only and personal-record context/query results
exceeding 100,000 characters return a nonretryable SQL/KV size error with
narrowing guidance. Canonical write outcomes are never cut off by this cap,
so a completed record write is not misreported as a retryable failure.
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

