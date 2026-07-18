# TinyCloud delegated exploration and secrets

Use the TinyCloud MCP tools as a resumable authority workflow. Never ask the
user to paste a secret value, private key, token, or delegation credential into
chat.

<!-- BEGIN GENERATED TINYCloud operation facts -->
The following facts are generated from `@tinycloud/operations/operations.json`:

- `tinycloud_account_applications_list` -> `tinycloud.account.applications.list@1`; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_account_spaces_list` -> `tinycloud.account.spaces.list@1`; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_auth_capabilities` -> `tinycloud.auth.capabilities@1`; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: no.
- `tinycloud_auth_import` -> `tinycloud.auth.import@1`; effects: local_write; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: no.
- `tinycloud_auth_request` -> `tinycloud.auth.request@1`; effects: local_write; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: no.
- `tinycloud_auth_status` -> `tinycloud.auth.status@1`; effects: read; postures: owner-openkey, delegate-session, local-owner-key, unauthenticated; sensitive output: no.
- `tinycloud_kv_delete` -> `tinycloud.kv.delete@1`; effects: destructive; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: no.
- `tinycloud_kv_get` -> `tinycloud.kv.get@1`; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_kv_head` -> `tinycloud.kv.head@1`; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: no.
- `tinycloud_kv_list` -> `tinycloud.kv.list@1`; effects: read; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_kv_put` -> `tinycloud.kv.put@1`; effects: write; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: no.
- `tinycloud_secrets_get` -> `tinycloud.secrets.get@1`; effects: read, local_write; postures: owner-openkey, delegate-session, local-owner-key; sensitive output: yes.
- `tinycloud_status` -> `tinycloud.status.get@1`; effects: read; postures: owner-openkey, delegate-session, local-owner-key, unauthenticated; sensitive output: no.
<!-- END GENERATED TINYCloud operation facts -->

<!-- BEGIN GENERATED TINYCloud operations coverage -->
Coverage is generated from the Commander registration ledger; legacy commands are not MCP tools.

- 1 migrated registration(s).
- 1 partially migrated registration(s).
- 111 legacy registration(s) remain Commander-owned.
- `auth import [source]` → `tinycloud.auth.import@1` (partially-migrated; remaining legacy inputs: v1 delegation artifact, v1 permission artifact without command, bare portable delegation, stored delegation wrapper, cross-user delegation persisted with activated=false).
- `secrets get <name>` → `tinycloud.secrets.get@1` (migrated).
<!-- END GENERATED TINYCloud operations coverage -->

## Account and KV exploration

1. A fresh `delegate-session` profile must first bootstrap its session through
   the CLI: emit one exact `tc auth request --cap ...` artifact, have the owner
   grant that artifact, and import the result with `tc auth import`. Start MCP
   only after the import succeeds.
2. Inspect posture with `tinycloud_status` or `tinycloud_auth_status`.
3. Call `tinycloud_account_spaces_list` and
   `tinycloud_account_applications_list`. If either returns
   `authority_required`, give the exact structured request to the account
   owner for `tc auth grant --stdin --yes`, then import the returned artifact
   with `tinycloud_auth_import`.
4. Choose a non-secrets space from those results. Use `tinycloud_kv_list` with
   an exact space and prefix. Follow the same request, owner grant, import,
   restart, and retry sequence when authority is required.
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
   Treat `delegate-session` as delegated authority even when its owner DID is
   the target space owner. Do not infer owner authority from metadata.
2. Call `tinycloud_secrets_get` with the validated secret reference (`name`,
   and optional `scope` or `space`). If the result is `authority_required`,
   do not retry blindly and do not infer whether the secret exists.
3. Present the exact structured `request` and its exact `approval` OpenKey
   action to the user for out-of-band approval. Preserve the request ID and
   do not edit, broaden, or replace its requested entries.
4. In a later call, use `tinycloud_auth_import` with the returned request ID
   and the approved delegation artifact. A process restart is expected to be
   safe. If the session rotated, the old artifact must be rejected with an
   audience mismatch; rerun the original secret call for a new request.
5. Retry the original `tinycloud_secrets_get` call after a successful import.
   The successful structured result is authoritative. Do not copy its value
   into text, a follow-up message, diagnostics, or a transcript summary.
6. If the result is `setup_required`, show the structured Secret Manager setup
   link. The link contains only the secret reference and target space; it never
   contains a secret value.

MCP hosts may retain tool arguments and successful results in their own
transcripts, caches, or evaluation records. TinyCloud controls only its own
logs and local profile state, not host-side transcript retention. Hosts should
apply their own sensitive-result retention and access controls.

This surface uses local stdio only. It has no continuation tool, resources,
prompts, elicitation, remote transport, generic permission grant, or secret
mutation tool.

This is a beta surface. Delegated posture is the default; owner-profile data
access requires explicit opt-in. The user must enter secrets only in Secret
Manager, never in chat.
