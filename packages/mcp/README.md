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

## Private diagnostic history (default off)

The private diagnostic spool is separate from the existing four-field stderr
log. No diagnostic tool, HTTP route, response header or result receipt is added.
Record grants and OAuth access tokens do not grant diagnostic access.

### Hosted configuration and protected controls

`TC_MCP_DIAGNOSTICS_ROOT` is an explicit absolute private diagnostic root; it has
no fallback to `TC_MCP_STATE_DIR`, `TC_HOME`, or the local diagnostic root. It
must be disjoint from the credential-state tree. Missing, invalid, overlapping
or inaccessible capture configuration must not change business requests. Merely
setting the root does **not** enable capture. Requests only discover existing
mappings from the service's verified HMAC tenant directory identifier to a
separate random diagnostic partition. Protected provisioning must first call
`resolveDiagnosticTenant(root, verifiedTenantId, { create: true })` from
`@tinycloud/operations/diagnostics`, using an identity established through the
existing verified-account boundary. This is an operator integration API, not a
public provisioning route or a CLI that accepts arbitrary identities. If that
mapping is unavailable, stop; never guess an identity or scan all tenants.
No subject or credential is stored in events, and request metadata cannot select
the partition. Provisioning a mapping leaves capture disabled.

An operator acting on an owner's request can use the offline command:

```text
tinycloud-mcp-http diagnostics <action> --root <absolute-root> --tenant <existing-64-hex-tenant-id> --owner-request
```

Actions are `status`, `enable`, `pause`, `resume`, `disable`, `history`, `export`
and `delete`. This command runs before loading the business server, discovering
OAuth metadata or opening a listener. Its authority is the protected OS account
and private filesystem access; `--owner-request` is the operator's explicit
acknowledgment, not a new authentication mechanism or an audit receipt. Tenant selection resolves an
**existing** verified mapping; the command never accepts an OAuth subject or
creates an arbitrary tenant mapping. `enable` arms metadata only; `pause` retains
history, `resume` restores capture, and `disable` disarms capture without deletion.

- `history` requires `--selection <json-file>`. Explicit selections use generated
  `event_ids`, `invocation_ids`, `source_ids`, or bounded `from`/`until` UTC times.
  An explicit `{"all":true}` can select current partition history for local review.
- `export` additionally requires `--out <directory> --expires <UTC-time>`.
  Export selection must be explicit and nonempty. Managed exports remain within
  the protected export subtree and source retention/deletion controls. An output
  outside the entire root requires `--external`; its expiry and later deletion
  cannot be enforced by the source. Exports are private, selected metadata, not
  automatic uploads.
- `delete` requires a selection and exactly one of `--pause-after` or
  `--keep-enabled`. It does not delete records, profiles, grants or approvals.

Pre-verification host/origin/auth failures have **no tenant authority**. They
are captured only when both `TC_MCP_DIAGNOSTICS_SERVICE=1` and the separately
controlled service partition are enabled. An operator addresses it with
`--service` instead of `--tenant ... --owner-request`; only service `enable`
may create this reserved mapping. Enabling a tenant never enables service capture.

One runtime/worker is shared by the application's per-request servers. Protocol
observations use public SDK transport and Standard Schema composition. HTTP
status, canonical operation status, size conversion, protocol send completion,
and real Node response finish/close/error remain independent facts. A finished
send is not client receipt, and a finished response is not evidence that a user
read it. Arbitrary request IDs, method/tool names, metadata, URLs, token claims,
keys, values, SQL, error prose and response content are not persisted. The only
supported client hint is `_meta["xyz.tinycloud/diagnostic-role"]` with
`catalog|record|verification|copy|approval|context|unknown`; it is marked
client-reported, never authority. Missing task/run/client linkage stays unknown.

### Local stdio and readiness limits

Local stdio attaches capture only with a validated
`TC_DIAGNOSTICS_CONTEXT` containing `{"version":1,"scope":"tc-apps"}` **and**
separate local capture enablement. A run/task identifier alone does not establish
scope. Use this only for an explicitly scoped, dedicated tc-apps process, not a
general long-lived shared MCP server. Stdout remains strictly MCP; local context
does not invent a hosted tenant or client identity.

Connection startup performs bounded policy discovery. Thereafter requests use
an immutable cached admission context while one background refresh discovers
live enable/resume/delete changes. Inbound messages and cancellation are never
queued behind discovery; queued or in-flight observations are never rebound to
a new generation. Requests racing a transition may lack history; later requests
use the refreshed policy. Do not retry a mutation merely to obtain history.

Coverage includes approval wait/verification/commit, grant replay, record/read/copy
phases and KV/SQL physical attempts as well as protocol and delivery boundaries.
An owner approval wait is not machine execution time; an unfinished mutation
remains unknown even if a later attempt succeeds. Metadata cannot establish
intended dates, units, record values or the client's final answer.

Hosted capture must remain disabled until the following separately authorized
deployment gates are complete. Source and loopback fixtures are not proof of a
released package or running container:

1. Release through the existing changeset process, then build the image from the
   actual published package. Record package versions, image digest and generated
   rules revision; verify installed ESM/CJS worker resolution and cold append,
   bounded drain, loss reporting and unchanged business exit/response behavior.
2. Provision a dedicated encrypted diagnostic volume, for example mounted at
   `/var/lib/tinycloud-diagnostics`, disjoint from the credential-state volume.
   Set `TC_MCP_DIAGNOSTICS_ROOT` only to that absolute mount. Keep
   `TC_MCP_DIAGNOSTICS_SERVICE` unset unless separately authorized; root
   configuration and tenant mapping alone never arm capture. Keep one replica,
   public logs and sysinfo disabled. The repository's production compose and image
   configuration deliberately add no mount or capture enablement.
3. Verify service-account ownership, 0700 directories and 0600 files, rejected
   symlink/unsafe-parent paths, encrypted storage and key recovery/rotation policy.
   Modes are not encryption. Budget 100 MiB per partition (including 10 MiB detail)
   and 1 GiB globally; ensure the volume and enabled-tenant count fit these caps.
   Metadata expires after 30 days, selected detail after 7 days. Missing/full/slow
   storage must lose diagnostics, not block or change business requests.
4. Establish snapshot/backup exclusion or enforceable expiry/deletion and encrypted
   protected transfer before enablement. Selected detail requires independent
   explicit intake and encrypted-disk/backup-policy acknowledgment; the hosted
   admin `enable` action enables metadata only. Never collect transcripts by
   directory scan or include credential state in diagnostic backups/exports.
5. With two synthetic tenants, verify protected mapping, status, selected
   export/import and cross-tenant isolation. Prove retention, pause/delete cutoff,
   incomplete-deletion reporting and idle cleanup across restart, container
   replacement and authorized redeploy. Then obtain explicit per-tenant metadata
   authorization. Hosted capture does not depend on an owner's laptop being online.
6. For rollback, disable capture and adapter emission first, without changing
   record grants, profiles or sessions. Decide explicitly whether to retain or
   delete history; verify managed exports/cases/imports follow expiry and deletion.
   External transfers and recipient backups cannot be recalled by source deletion.
   Remove capture configuration before an older image is restored and prove that
   restart/restore cannot re-enable capture or resurrect deleted copies. Reverting
   an image digest alone does not prove data/configuration rollback.

Diagnostic history is best effort, not an audit trail; lost, expired and unfinished
evidence must remain visible as gaps. Actual client/phone coverage and deployment
encryption, persistence and backup guarantees require their own authorized
acceptance; neither package installation nor a server fixture establishes them.
Health recovery retains at most 64 attribution buckets per producer/helper.
Terminal failure or overflow can leave loss unknown; recovery is best effort,
not guaranteed durable accounting.

Behavior checks live in `src/diagnostics.test.ts`,
`src/hosted-diagnostics.test.ts`, `src/diagnostics-admin.test.ts`,
`src/diagnostics-stdio.test.ts`, and the existing
registered hosted write scenario in `src/http.e2e.test.ts`. Run them through the
package's isolated test runner after building all integrated dependencies.

### Synthetic calibration (2026-10-16)

From the SDK root, after building the runtime prerequisites:

```sh
bun packages/mcp/test-support/diagnostics-measure.ts \
  --node20 /absolute/path/to/node20 \
  --wrapper /absolute/path/to/prompts/skills/tc-apps/tc-wrapper.sh \
  --samples 3 --calls 8 --records 205
```

The fixture writes a private results file with runtime versions, source hashes,
raw observations and limitations. It uses disposable homes/profiles and loopback
services, not owner records or installed clients. The Node 20.20.2 workload runs
registered built MCP handlers, one cold plus eight repeated calls, and eight
real CLI/wrapper children in two runs. The separate Bun 1.4.2 workload executes
source apps operations: a 100-record read and a fresh 205-record SQLite rebuild.
Its synthetic invocation headers replace cryptographic authorization; it is not
Node copy timing or hosted OAuth acceptance.
These were unpublished worktree builds labeled operations/MCP `0.6.1-beta.3`,
CLI `1.2.6-beta.3`, SDK services/core `3.2.6-beta.2`, and Node SDK
`3.2.6-beta.3`. Those labels do not claim that registry releases contain this
feature.

The original 64-event queue lost 12–16 of 131 copy observations in each of three
healthy samples. One concurrent Node sample retained 511 of 515 expected events.
The revised bounds are **128 events / 256 KiB**, eight-event batches, **200 ms**
lock wait and **300 ms** terminal drain (previously 100/150 ms). Ten instrumented
eight-child wrapper samples then retained all 80 child links; none of their 240
observed helper drains reported drops, pending work or failure. Instrumentation
can affect scheduling; this is evidence for the chosen bounds, not a capacity
or losslessness guarantee.

Final integrated run: three fresh-process samples per mode, fixed off/on/held-lock
order, unflushed OS caches. Ranges below are **not percentiles**. Whole-process
GNU `time` CPU includes reaped-child CPU where supplied by the OS; maximum RSS
is a high-water maximum, not summed concurrent memory. The separate Bun node
fixture is excluded from Node CPU/RSS; the Bun SQLite backend is included in its
consumer. No exclusive-host, negligible-overhead or latency-SLA claim is made.

| Measurement | Off | On | Held writer lock |
|---|---:|---:|---:|
| Node whole-process wall, s | 8.17–8.23 | 8.99–9.17 | 9.41–9.78 |
| Node CPU user + system, s | 23.64–23.87 | 27.46–27.68 | 24.09–24.30 |
| Node maximum RSS, KiB | 394992–397864 | 404700–416916 | 406408–414364 |
| Node module import, ms | 1155.98–1382.16 | 1240.65–1349.75 | 1155.27–1244.02 |
| First MCP call, ms | 869.26–885.34 | 876.23–911.75 | 885.30–897.97 |
| Repeated MCP calls, ms (24/mode) | 456.72–584.36 | 457.82–589.20 | 457.31–591.89 |
| Eight-child fan-out, ms | 1708.12–2043.11 | 2390.84–2522.70 | 2233.48–2514.81 |
| Node local review, ms | 4.20–4.33 | 97.75–100.47 | 10.51–142.26 |
| Bun whole-process wall, s | 0.65–0.68 | 0.77–0.79 | 2.70–2.78 |
| Bun CPU user + system, s | 1.47–1.50 | 1.76–1.81 | 1.76–1.78 |
| Bun maximum RSS, KiB | 216028–229384 | 219128–230236 | 221364–227196 |
| 100-record read, ms | 17.29–17.85 | 19.65–22.45 | 19.96–20.94 |
| 205-record copy rebuild, ms | 36.67–41.75 | 48.36–51.24 | 47.30–52.19 |
| Bun terminal drain, ms | 4.29–6.30 | 53.60–59.74 | 300.24–300.28 |
| Bun local review, ms | 4.81–4.94 | 23.35–23.66 | 10.82–12.05 |

Paired on-minus-off whole-process wall differences were +0.76–1.00 s
(+9.2–12.2%) for Node and +0.11–0.12 s (+16.2–18.5%) for Bun. Whole-process
time includes setup, business work, drain, review and exit; module import and
first-call measurements do not isolate process startup. No human approval wait
or interpretation was measured. Healthy wrappers did not take their existing
2/4-second retry sleeps; those are exercised separately by wrapper acceptance.

All nine mode/sample pairs preserved synthetic business results and effects.
Each healthy Node sample acknowledged its own 315 events with zero drops and
reviewed 515 events, 21 starts/finishes and two run IDs; each healthy Bun sample
acknowledged/reviewed all 131 events with one start/finish. Metadata occupied
325621–325656 bytes and 84554–84565 bytes respectively; selected-detail bytes
were zero, not a selected-detail performance result. Ordinary CLI child health
counters are unavailable. These fixture-owned runtimes omit descriptors/task
IDs, so `descriptor_missing` and `linkage_unknown` remain explicit.

With the writer lock held, each Node runtime lost all 315 submitted observations
(281 admitted), and each Bun runtime lost all 131 (128 admitted). No events
appeared in the sampled reviews; empty review remains `coverage_unknown`.
Terminal waits were about 300 ms; Bun's subsequent asynchronous cleanup took
1709–1710 ms. The lock remained held through business-child completion and the
measured runtime's close, not independently observed child-writer quiescence:
late child evidence after unlocking remains possible. Usage inspection is not
atomic with review. Native FIFO stalls, injected append-time ENOSPC, filesystem
child death, denied paths and incomplete deletion are separate installed-package
fixtures, not proof of actual deployment full-disk or container durability.

## Tools

The local server exposes 17 tools. Hosted mode exposes 20: it adds
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
