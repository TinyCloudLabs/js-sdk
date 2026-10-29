# TinyCloud delegated exploration and secrets

Use the TinyCloud MCP tools as a resumable authority workflow. Never ask for
secret values, private or session keys, recovery phrases or API keys. Approval
codes and delegations are fine to send in chat.

<!-- BEGIN GENERATED TINYCloud operation facts -->
The following facts are generated from `@tinycloud/operations/operations.json`:

- `tinycloud_account_applications_list` -> `tinycloud.account.applications.list@1`; surfaces: local, hosted; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_account_spaces_list` -> `tinycloud.account.spaces.list@1`; surfaces: local, hosted; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_apps_context` -> `tinycloud.apps.context@1`; surfaces: hosted, public; effects: read, local_write; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_apps_query` -> `tinycloud.apps.query@1`; surfaces: hosted, public; effects: read, write, destructive; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_apps_read` -> `tinycloud.apps.read@1`; surfaces: hosted, public; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_apps_write` -> `tinycloud.apps.write@1`; surfaces: hosted, public; effects: destructive; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_auth_capabilities` -> `tinycloud.auth.capabilities@1`; surfaces: local, hosted; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: no.
- `tinycloud_auth_import` -> `tinycloud.auth.import@1`; surfaces: local; effects: local_write; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: no.
- `tinycloud_auth_request` -> `tinycloud.auth.request@1`; surfaces: local, hosted; effects: local_write; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: no.
- `tinycloud_auth_status` -> `tinycloud.auth.status@1`; surfaces: local, hosted; effects: read; postures: owner-openkey, delegate-session, local-owner-key, unauthenticated; sensitive output: no.
- `tinycloud_knowledge_list` -> `tinycloud.knowledge.list@1`; surfaces: local, hosted; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_knowledge_read` -> `tinycloud.knowledge.read@1`; surfaces: local, hosted; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_kv_delete` -> `tinycloud.kv.delete@1`; surfaces: local, hosted; effects: destructive; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: no.
- `tinycloud_kv_get` -> `tinycloud.kv.get@1`; surfaces: local, hosted; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_kv_head` -> `tinycloud.kv.head@1`; surfaces: local, hosted; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: no.
- `tinycloud_kv_list` -> `tinycloud.kv.list@1`; surfaces: local, hosted; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_kv_put` -> `tinycloud.kv.put@1`; surfaces: local, hosted; effects: write; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: no.
- `tinycloud_secrets_get` -> `tinycloud.secrets.get@1`; surfaces: local, hosted; effects: read, local_write; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_secrets_status` -> `tinycloud.secrets.status@1`; surfaces: local; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: no.
- `tinycloud_sql_execute` -> `tinycloud.sql.execute@1`; surfaces: local, hosted; effects: write, destructive; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_sql_query` -> `tinycloud.sql.query@1`; surfaces: local, hosted; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_sql_schema_inspect` -> `tinycloud.sql.schema.inspect@1`; surfaces: local, hosted; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_status` -> `tinycloud.status.get@1`; surfaces: local, hosted; effects: read; postures: owner-openkey, delegate-session, local-owner-key, unauthenticated; sensitive output: no.
<!-- END GENERATED TINYCloud operation facts -->

<!-- BEGIN GENERATED TINYCloud operations coverage -->
Coverage is generated from the Commander registration ledger; legacy commands are not MCP tools.

- 4 migrated registration(s).
- 1 partially migrated registration(s).
- 150 legacy registration(s) remain Commander-owned.
- `auth import [source]` → `tinycloud.auth.import@1` (partially-migrated; remaining legacy inputs: v1 delegation artifact, v1 permission artifact without command, bare portable delegation, stored delegation wrapper, cross-user delegation persisted with activated=false).
- `secrets get <name>` → `tinycloud.secrets.get@1` (migrated).
- `secrets probe <name>` → `tinycloud.secrets.status@1` (migrated).
- `knowledge list` → `tinycloud.knowledge.list@1` (migrated).
- `knowledge read <app_id> [concept]` → `tinycloud.knowledge.read@1` (migrated).
<!-- END GENERATED TINYCloud operations coverage -->

## Account and KV exploration

With hosted Streamable HTTP, call `tinycloud_connect`, give the owner the returned `approvalUrl` to approve in OpenKey, then call `tinycloud_connect` again. When a tool returns `authority_required` with `approval.url`, give the owner that link, wait for their approval, then retry the same call unchanged. If the result has no `approval.url`, stop and report it; don't try another route. The `tinycloud_auth_import` instructions below are for local stdio only. See the [hosted MCP guide](https://docs.tinycloud.xyz/cli/mcp).

1. For local stdio, sign in once with `tinycloud onboard` and start MCP with
   that profile: `tinycloud-mcp --profile default --allow-owner-profile`.
2. Inspect posture with `tinycloud_status` or `tinycloud_auth_status`.
3. Call `tinycloud_account_spaces_list` and
   `tinycloud_account_applications_list`. If either returns
   `authority_required`, send the owner `approval.url` and one line on what it
   allows; pass back the code or delegation they send, exactly as sent, to
   `tinycloud_auth_import`.
4. Choose a non-secrets space from those results. Use `tinycloud_kv_list` with
   an exact space and prefix. Follow the same link-and-retry steps when
   authority is required.
5. Use `tinycloud_kv_get` for one exact returned key. The default base64
   representation is byte-exact; request `text` or `json` only when the stored
   bytes have that encoding. A list grant does not imply get authority.
6. Before replacing or deleting existing data, call `tinycloud_kv_head` and
   pass its ETag. Use `tinycloud_kv_put` mode `create` to reject collisions,
   `replace` with an ETag for optimistic concurrency, or `upsert` only when the
   user explicitly permits overwriting the key.
7. Use `tinycloud_kv_delete` with the observed ETag when deleting an existing
   object. Treat a precondition failure as a concurrent change and inspect the
   object again rather than retrying blindly.
8. Do not broaden a path, substitute a sibling key, change the audience, or
   use generic KV tools against account or secrets spaces. Use
   `tinycloud_secrets_get` for secrets.

## Secret workflow

1. Inspect posture first with `tinycloud_status` or `tinycloud_auth_status`.
   Treat the profile as delegated authority even when its owner DID is
   the target space owner. Do not infer owner authority from metadata.
2. Call `tinycloud_secrets_get` with the validated secret reference (`name`,
   and optional `scope` or `space`). If the result is `authority_required`,
   do not retry blindly and do not infer whether the secret exists.
3. Send the owner the approval link and one line on what it allows. Preserve
   the request ID and do not edit, broaden, or replace its requested entries.
4. In a later call, use `tinycloud_auth_import` with the returned request ID
   and the code or delegation the owner sends back in chat, passed on exactly
   as sent. A process restart is expected to be safe. If the session rotated,
   the old artifact must be rejected with an audience mismatch; rerun the
   original secret call for a new request.
5. Retry the original `tinycloud_secrets_get` call after a successful import.
   The successful structured result is authoritative. Do not copy its value
   into text, a follow-up message, diagnostics, or a transcript summary.
6. If the result is `setup_required`, show the structured Secret Manager setup
   link. The link contains only the secret reference and target space; it never
   contains a secret value.
7. After the owner opens the setup link, poll `tinycloud_secrets_status` for
   the same names with backoff until they are `ready`, then retry
   `tinycloud_secrets_get`. On `consent_required`, obtain approval through the
   existing flow (`tinycloud_secrets_get`'s `authority_required` approval).

`tinycloud_secrets_status` (local/stdio MCP only) never signs in. If it returns `details.recovery`, follow it exactly: `sign_in` → run its `command` in a terminal to create a stored session; `complete_migration` → call its `tool` (`tinycloud_auth_capabilities`) once. Then retry status. If there is no `command` (unusual profile name), sign in to that profile with the CLI.

MCP hosts may retain tool arguments and successful results in their own
transcripts, caches, or evaluation records. TinyCloud controls only its own
logs and local profile state, not host-side transcript retention. Hosts should
apply their own sensitive-result retention and access controls.

Agents that can run the CLI use https://agents.tinycloud.xyz/onboarding.
Others connect any remote-MCP client (for example Claude or ChatGPT) to
hosted MCP at `https://mcp.tinycloud.xyz/mcp` using Streamable HTTP and
OpenKey OAuth. Meetings are available through the CLI.
Connection documentation: https://docs.tinycloud.xyz/cli/mcp

The MCP server has no resources, prompts, elicitation, generic permission grant,
or secret mutation tool.

This is a beta surface. Delegated posture is the default; owner-profile data
access requires explicit opt-in. The user must enter secrets only in Secret
Manager, never in chat.
