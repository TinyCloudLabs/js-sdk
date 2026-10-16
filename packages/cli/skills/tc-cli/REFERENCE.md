# TC CLI Command Reference

<!-- BEGIN GENERATED TINYCloud operations coverage -->
This release has **Commander coverage tracked, not complete parity**:

- 2 migrated registration(s).
- 1 partially migrated registration(s).
- 128 legacy registration(s) remain Commander-owned.

- `auth import [source]` → `tinycloud.auth.import@1` (partial; legacy inputs: v1 delegation artifact, v1 permission artifact without command, bare portable delegation, stored delegation wrapper, cross-user delegation persisted with activated=false).
- `secrets get <name>` → `tinycloud.secrets.get@1` (migrated).
- `secrets probe <name>` → `tinycloud.secrets.status@1` (migrated).
<!-- END GENERATED TINYCloud operations coverage -->

## Calling the CLI

`/usr/sbin/tc` (iproute2 traffic control) shadows the older `tc` name on many Linux hosts, so the CLI is called `tinycloud`. Call the CLI by path, preferring the private install from https://agents.tinycloud.xyz/cli (set `TC_BIN` to use another one):

```bash
TC="${TC_BIN:-$HOME/.local/share/tinycloud/cli/node_modules/.bin/tinycloud}"   # TC_BIN, else where agents.tinycloud.xyz/cli installs it
[ -n "${TC_BIN:-}" ] || [ -x "$TC" ] || ! command -v npm >/dev/null || TC="$(npm prefix --global)/bin/tinycloud"   # else a global npm install
[ -x "$TC" ] || { echo "TC_NOT_FOUND: $TC is not executable; install the CLI from https://agents.tinycloud.xyz/cli or set TC_BIN" >&2; exit 1; }
"$TC" --version
```

## Global Options

| Flag | Description |
|------|-------------|
| `-p, --profile <name>` | Profile to use |
| `-H, --host <url>` | Node URL override (default `https://tee.node.tinycloud.xyz`) |
| `-v, --verbose` | Verbose output |
| `-q, --quiet` | Suppress non-essential output |
| `--no-cache` | Disable caching |
| `--json` | Force machine-readable output |
| `--replication` / `--no-replication` | Enable/disable read-through replication for this invocation; `TC_REPLICATION=1` enables it by default, with command flags taking precedence |
| `--replication-debug` | Write per-read, write and sync diagnostics to stderr |

## Context and Login

```bash
"$TC" profile list                    # use a new profile name; keep existing profiles
"$TC" init --name publisher --key-only
"$TC" --profile publisher auth login --device --manifest builtin:share-publishing --expiry 7d
"$TC" --profile publisher context --json
```

`context` always emits JSON: profile, `ownerDid`, `sessionDid`, host, `spaceId` and local session expiry, with `access: "not-tested"`. It never prints keys or signed material.

| `auth login` flag | Description |
|------|-------------|
| `--device` | Approve on another device (phone) through OpenKey device authorization. Requires a KV-scoped `--manifest` (no `tinycloud.sql`, no secret decrypt). Prints `Approve on your phone: URL (code XXXX-XXXX)` to stderr and waits for the whole approval window |
| `--manifest <file>` | Request only this manifest's permissions: one space, plus raw `tinycloud.encryption` network entries (space `encryption`) such as a secrets decrypt grant. Every scoped login adds `tinycloud.capabilities/read` on path `""` in that space when missing (OpenKey requires it to sign). File path, `base64:<json>`, or `builtin:share-publishing` |
| `--expiry <duration>` | Session lifetime (`1h`, `7d`, milliseconds; at least `1m`) counted from approval; ISO dates are refused because OpenKey signs approval time plus a lifetime. Enforced against the signed session on every login path. Device login: at most `30d`, default `30d` |
| `--owner <did>` | Refuse approval by any identity other than this `did:pkh`; must agree with an owner the profile already recorded. OpenKey preselects that owner's key, so this is how to sign in with a key that is not the account's primary key; it works on a plain login without `--manifest` too. Also names the secrets owner for a manifest's `secrets` when the profile has no recorded owner |
| `--replace-session` | Scoped or device login: replace a live session the new scope would narrow, change or shorten (otherwise `SESSION_IN_USE`); renewals and widenings that last at least as long need no flag |
| `--replication-prefix <prefix>` | Repeatable login request; adds `get` + `sync` only when an unrestricted covering `get` is already requested. Saves prefixes on the profile and reapplies them on later logins and rotation |
| `--replication-allow-secrets` | Explicitly allow prefixes in the `secrets` space or `vault` tree; replication stores ciphertext only |
| `--method openkey\|local` | Browser OpenKey flow or local Ethereum key |
| `--paste`, `--no-popup` | Browser flow without a local callback / without opening a browser. `--paste` reads the owner's code from stdin (newline-terminated; a final unterminated line is accepted); stdin ending without a code fails with `PASTE_CODE_MISSING` (exit 3) naming the approval URL |

Device login JSON lists the signed, approved `permissions`, owner-unchecked `declined` capabilities, `ownerDid`, `spaceId` and `expiresAt`. `tinycloud auth request --manifest FILE --grant --device` adds another space to a logged-in profile the same way (default lifetime 7d). `tinycloud enable share [--replace-session]` is shorthand for device login with `builtin:share-publishing`. OpenKey refuses `tinycloud.sql` and other abilities outside its device policy; use browser login (`--method openkey --manifest`) for those. Non-interactive browser login without `--paste` or `--no-popup` fails fast with `INTERACTIVE_LOGIN_REQUIRED`. Only an explicit `--host` is stored on the profile. Errors: `MANIFEST_REQUIRED`, `SCOPE_REJECTED` (OpenKey refused a capability; the message names it), `SESSION_IN_USE` (the request or the approved scope would narrow a live session; use a new profile or `--replace-session`), `PROFILE_CHANGED_DURING_LOGIN` (another login, key rotation or logout changed the profile while approval was pending; nothing saved), `PROFILE_STATE_INCONSISTENT` (profile, key and session disagree after an interrupted write; `--replace-session` or a new profile), `PROFILE_LOCK_TIMEOUT` (another process held the profile lock past 45 s), `LOCAL_OWNER_PROFILE` (scoped or device login on a local-owner-key profile; use a separate profile), `OPENKEY_UNREACHABLE`, `DEVICE_AUTH_DENIED`, `DEVICE_AUTH_EXPIRED`, `DEVICE_AUTH_BINDING_MISMATCH` (OpenKey's approval metadata disagrees with the signed grant), `OPENKEY_OWNER_MISMATCH`, `OPENKEY_GRANT_BROADENED`, `OPENKEY_EXPIRY_EXCEEDED` (the signed session outlives `--expiry`). Owner addresses compare case-insensitively (EIP-55 or lowercase); chain id and space name compare exactly. See [AUTH.md](AUTH.md).

`builtin:share-publishing` requests, in the owner's `default` space, exactly:

| Prefix | Abilities | Why |
|------|-------------|-----|
| `""` (space root) | `capabilities/read` | required by OpenKey to sign any delegation; lets the CLI read its own capability set |
| `xyz.tinycloud.share/shares/` | `kv/put` | store a bearer link's source |
| | `kv/get` | mint the link's read-only child delegation (a session delegates only what it holds) |
| `shares/` | `kv/put` | store an addressed share's encrypted source; `--action edit` |
| | `kv/get`, `kv/metadata` | back the Policy/v3 root that grants recipients read; `--notify` delivery authorization |
| | `kv/list` | `--action list` on a `--prefix` share |

No `del` anywhere and no `list` on the bearer prefix: no `tinycloud share` command uses them. Inspect and receive use the link's own authority. Revoke signs `tinycloud.delegation/revoke` over the delegation's own CID and a Policy/v3 root revocation with the issuing session key, not a space capability. OpenKey shows the capability read as required (not uncheckable), so it is always in the signed grant and never in `declined`.

## Delegations

```bash
"$TC" delegation create \
  --to did:pkh:eip155:1:0xRecipient... \
  --path kv/shared \
  --actions kv/get,kv/put \
  --expiry 24h

"$TC" delegation list              # All
"$TC" delegation list --granted    # Granted by me
"$TC" delegation list --received   # Received by me
"$TC" delegation info <cid>
"$TC" delegation revoke <cid>
```

Actions are auto-prefixed with `tinycloud.` if not already.

`tinycloud auth import` stores delegations in `additional-delegations.json`. Every replay path installs only a grant with a locally verified proof and a binding containing its signed authority; unbound and proof-less grants never install, including while migration is deferred. [AUTH.md](AUTH.md#imported-delegations-and-their-request-bindings) covers migration and recovery.

### Stored grants

```bash
"$TC" --profile PROFILE auth grants list --json
"$TC" --profile PROFILE auth grants remove <cid>
"$TC" --profile PROFILE auth grants remove <cid> --revoke --yes
```

`list` is local and does not contact the node. Its JSON contains `profile`, `session` (`cid` recomputed from stored header and `expiresAt`, or `null`), `localVerification` (`available`, `session_missing`, `session_expired`, `session_invalid`), and `grants`. Each indexed grant row contains `cid` (CID-shaped or `null`), `expiry`, `expired`, `local` (`verified`, `refused`, `not_checked`, `for_another_key`), `reason` (fixed skip code or `null`), `node: "not_checked"`, `bound`, `proof` (`siwe`, `compact`, `missing`, or `null`), `source`, `scope`, and `scopeSource` (`signed` or `stored`). `for_another_key` means the stored audience names another key; its scope is unverified stored metadata and it cannot install in this session. Local verification checks signed scope and binding, not the node's delegation chain or revocation status. Human output shows `CID | LOCAL | EXPIRES | SOURCE | BOUND | SCOPE` and the session CID.

`for_another_key` is decided from a verified signed compact audience, CID, and matching transport DID, not an unsigned `delegateDID` alone. Tampered records retain their refusal reason, and proofless records retain `proof_missing`.

Local `remove` deletes every row matching that exact CID, and is available to delegates. `--revoke` alone is owner-only: it uses normal verified local-node discovery unless a host is explicit, revokes on the node, and removes the rows only after success. If the local removal then fails, `GRANT_REVOKED_LOCAL_REMOVE_FAILED` directs a local-only retry without `--revoke`. OpenKey cannot sign raw `urn:cid` authority on the deployed version; owner OpenKey revocation uses a verified CID-bound owner-space fallback, or immediately fails `RAW_RECAP_RESOURCE_UNSUPPORTED`. Local removal does not revoke the delegation; delegated sessions cannot use `--revoke` because this SDK cannot issue a delegatee self-revocation.

A concurrent local removal after revocation reports `removed: 0` as success. Other local cleanup failures include `error.meta.causeCode` (for example `PROFILE_LOCK_TIMEOUT`).

## Spaces

```bash
"$TC" space list
"$TC" space create myspace
"$TC" space info                   # Current space
"$TC" space info <space-id>        # Specific space
"$TC" space switch myspace
```

`space list` reads the owner's account registry (`account/spaces/`) when the session holds `tinycloud.kv/get` and `tinycloud.kv/list` on the account space's `spaces/` prefix, and falls back to `tinycloud.space/list` only when the session holds that. A session with neither (including the default OpenKey owner sign-in, which covers only the `default` space) fails with `PERMISSION_DENIED` (exit 5) naming both; an owner grants the registry read with `"$TC" auth request --grant --cap tinycloud.kv:account:spaces/:get,list`.

## Profiles

Multiple identities/environments with isolated keys and sessions.

```bash
"$TC" profile list
"$TC" profile create staging --host https://staging.tinycloud.xyz
"$TC" profile show                 # Current profile
"$TC" profile switch staging       # Change default
"$TC" profile delete old-profile
```

Per-command override: `tinycloud kv get mykey --profile staging`

## Secrets

Secrets are stored as network-encrypted inline envelopes and read through
`tinycloud.encryption/decrypt`. Secret names are env-style uppercase
identifiers such as `FIREFLIES_API_KEY`. `tinycloud secrets network show` accepts
either a short network name or a full
`urn:tinycloud:encryption:<ownerDid>:<network>` identifier, and `tinycloud secrets
network grant` takes the short name, resolves the network, and issues
`tinycloud.encryption/decrypt` on that network. Share the decrypt grant
separately from any KV or SQL reads the app also needs.

```bash
"$TC" secrets network init
"$TC" secrets network show
"$TC" secrets network grant did:pkh:eip155:1:0xRecipient...

printf '%s' "$ANTHROPIC_API_KEY" | "$TC" secrets put ANTHROPIC_API_KEY --stdin   # keeps the value out of argv and shell history
"$TC" secrets get ANTHROPIC_API_KEY
"$TC" secrets get ANTHROPIC_API_KEY -o key.txt   # atomic owner-only (0600) replacement
"$TC" secrets list
"$TC" secrets delete ANTHROPIC_API_KEY
```

A missing secret makes `tinycloud secrets get` exit 4 (`NOT_FOUND`). For an identity that is not local, `error.setup` carries the owner's request link; a local identity (or a name/scope no link can express) gets only a hint naming `tinycloud secrets put NAME --stdin`. `tinycloud secrets doctor NAME` hints `tinycloud secrets request NAME` for a missing secret, or `tinycloud secrets put NAME --stdin` for a local identity. `tinycloud secrets get --delegation` follows the same rule, and a delegated read the node refuses (403, a capability 401, `AUTH_UNAUTHORIZED`) exits 5.

### Asking the owner for a secret: `request`, `wait`, `manage`

`/usr/sbin/tc` (iproute2 traffic control) can shadow the older `tc` name on `PATH`, so scripts call the CLI by absolute path:

```bash
TC="${TC_BIN:-$HOME/.local/share/tinycloud/cli/node_modules/.bin/tinycloud}"   # TC_BIN, else where agents.tinycloud.xyz/cli installs it
[ -n "${TC_BIN:-}" ] || [ -x "$TC" ] || ! command -v npm >/dev/null || TC="$(npm prefix --global)/bin/tinycloud"   # else a global npm install
[ -x "$TC" ] || { echo "TC_NOT_FOUND: $TC is not executable; install the CLI from https://agents.tinycloud.xyz/cli or set TC_BIN" >&2; exit 1; }
"$TC" --profile agent secrets request OPENAI_API_KEY --requester "agent@host" --json
# {"url":"https://secrets.tinycloud.xyz/request?owner=…&name=OPENAI_API_KEY&requester=…&v=1","names":["OPENAI_API_KEY"],"owner":"did:pkh:eip155:1:0x…"}
# send the url to the owner once, then:
"$TC" --profile agent secrets wait OPENAI_API_KEY --timeout 9m --json
"$TC" --profile agent secrets get OPENAI_API_KEY --raw
"$TC" secrets manage OPENAI_API_KEY --no-open --json   # {"url":"…","opened":false}: the replace/manage page
```

- **`secrets request <NAME...> [--scope S | --app ID] [--owner DID] [--requester LABEL] [--open]`** prints `{url, names, scope?, owner}` and exits 0. It is offline: no session, no node request. 1–10 names (`^[A-Z][A-Z0-9_]*$`, ≤ 64, duplicates dropped). `--app ID` derives the scope from an app id (`xyz.tinycloud.feed` → `xyz-tinycloud-feed`); `--app` with `--scope` exits 2. `--requester` defaults to `user@host`. `--open` also opens the link; a failure to open only adds a `BROWSER_OPEN_FAILED` warning on stderr. Errors: 2 for `INVALID_SECRET_NAME`, `TOO_MANY_SECRET_NAMES`, `INVALID_SECRET_SCOPE`, `INVALID_REQUESTER`, `INVALID_OWNER`, `OWNER_MISMATCH`, `LOCAL_OWNER_PROFILE`; 3 for `OWNER_DID_UNKNOWN` (pass `--owner`).
- **`secrets wait <NAME...> [--scope S | --app ID] [--owner DID] [--timeout D]`** polls until every name is readable. `D` is `0`, `Ns` or `Nm`, default `5m`, at most `9m`; `--timeout 0` makes exactly one check (≤ 21 s). The whole wait is bounded by timeout + 21 s. Each check runs in a child process that is killed if it overruns.
- **`secrets manage [NAME...] [--scope S | --app ID] [--no-open]`** prints `{url, opened}` for the Secret Manager page, opening a browser unless `--no-open`.

**`wait` never signs in: it needs a stored session and doesn't accept `TC_PRIVATE_KEY`** (an explicit key exits 3). It never writes profile state, never saves a consent request, never prints a value and never prompts. After a CLI upgrade, run one normal command per profile first (for example `tinycloud --profile agent auth caps`); otherwise the first `wait` returns `PROFILE_MIGRATION_REQUIRED` once, with that command in `error.recovery.command`.

| `wait` exit | Meaning |
|---|---|
| 0 | stdout `{status:"ready", names, scope?}` |
| 8 | `PENDING`: stdout `{status:"pending", pending, present, url}` (or `hint` instead of `url` for a local identity). Rerun `wait` without re-sending the link |
| 5 | `PERMISSION_DENIED`: `error.recovery` `{action:"request_access", names, owner, scope?}` names the denied names; `error.setup` covers names still pending |
| 3 | `AUTH_REQUIRED`: no stored session, an expired one, a 401, or `TC_PRIVATE_KEY` set. `error.recovery.command` is the persistent login to run once |
| 2 | usage, `OWNER_MISMATCH` |
| 6 | `NETWORK_ERROR` after repeated node failures; `error.progress` `{present, pending}` from the last successful check |
| 1 | `PROFILE_MIGRATION_REQUIRED` (run `error.recovery.command`, `tinycloud --profile P auth caps`, once, then retry) or `PROBE_FAILED` |
| 130 | `CANCELLED` (SIGINT/SIGTERM); `error.progress` when a check had succeeded |

**Which identity gets a link (posture table):**

| Identity | `request` | missing secret on `get` / `wait` |
|---|---|---|
| `owner-openkey` (recorded owner) | link for the recorded owner | `error.setup` / `url` |
| `delegate-session` | link for the owner of its space (or `--owner`) | `error.setup` / `url` |
| key-only `did:key` with no recorded owner | `OWNER_DID_UNKNOWN` (3) unless `--owner` | `wait`: needs a session (3) |
| `local-owner-key`, a profile holding a `privateKey`, `--private-key`, `TC_PRIVATE_KEY` | `LOCAL_OWNER_PROFILE` (2) | hint `tinycloud secrets put NAME --stdin`, no link |

**Error JSON fields** (stderr, JSON mode; only these keys ever appear in `error`: `code`, `message`, `hint`, `recovery`, `setup`, `progress`, `meta`, `warnings`):
- `error.setup` `{url, names, scope?, owner, action:"add_secret"}`: the canonical request link, on `NOT_FOUND` and on `wait`'s `PERMISSION_DENIED` for pending names.
- `error.recovery`: `{action:"sign_in", command?}` (a persistent login), `{action:"complete_migration", command?, operationId:"tinycloud.auth.capabilities"}`, or `{action:"request_access", names, owner, scope?}`. `command` is omitted for profile names that are not shell-safe; sign in to that profile, or run `auth caps` for it, yourself.
- `error.progress` `{present, pending}`: on `NETWORK_ERROR` and `CANCELLED` from `wait`, only after at least one successful check.

### Scoped secret reads for agents

An agent profile gets read access to named secrets through a scoped OpenKey paste login with a manifest that names them; [AUTH.md](AUTH.md#secret-reads-for-an-agent) has the full flow. Device login cannot grant secrets.

```bash
echo '{ "app_id": "my.agent", "space": "secrets", "secrets": { "OPENAI_API_KEY": true } }' > agent.json
"$TC" init --name agent --key-only
"$TC" --profile agent auth login --method openkey --paste --manifest agent.json --owner did:pkh:eip155:1:0xOWNER < /dev/null
# exits 3 (PASTE_CODE_MISSING) and names the approval URL; the owner approves and returns a code
printf '%s\n' "$CODE" | "$TC" --profile agent auth login --method openkey --paste --manifest agent.json --owner did:pkh:eip155:1:0xOWNER
"$TC" --profile agent secrets get OPENAI_API_KEY --raw
```

`secrets: { NAME: true }` requests, in the owner's `secrets` space, `kv/get` on `vault/secrets/NAME` and `capabilities/read` on `""`, plus the raw network entry `{ "service": "tinycloud.encryption", "space": "encryption", "path": "urn:tinycloud:encryption:<ownerDid>:default", "actions": ["tinycloud.encryption/decrypt"] }`. The owner DID comes from the profile's recorded owner, else `--owner`, and its address is EIP-55 checksummed in the URN; with neither the login fails with `OWNER_DID_UNKNOWN`. The JSON result lists approved `permissions` and `declined` entries. A decrypt signed inside the owner's space by an older OpenKey deployment is not a raw grant: scoped login reports it in `declined` and omits it from saved permissions. Browser `auth request --grant` or secret-read escalation refuses that old nested proof before activating or storing a grant (`OPENKEY_GRANT_BROADENED`); a renewed approval must sign the raw network grant.

When neither stdin nor stderr is a terminal, `secrets get|list|put|delete` on an OpenKey profile that lacks the grant fails with `PERMISSION_DENIED` (exit 5) and a scoped paste-login hint. Missing or expired sessions instead fail with `AUTH_REQUIRED` (exit 3) before a canonical read invokes the node or starts an unscoped browser refresh. On any profile kind, a stored session that has expired (a signed session, or one `tinycloud auth import` created from a compact UCAN) or no longer verifies fails with `AUTH_REQUIRED` (exit 3) and a sign-in hint before any node request, never as a retryable `NODE_ERROR`; operations and MCP report a non-retryable `AUTH_REQUIRED`. Any service result coded `AUTH_REQUIRED` or `PERMISSION_DENIED` without an HTTP status now exits 3 or 5 instead of 1 in commands using `cliErrorFromService` (account, delegation, DuckDB, encryption, KV, secrets, SQL, and vars); this preserves operation auth codes as typed errors.

## Local Replicas

`tinycloud replica` keeps a durable, read-only copy of one KV prefix on this device. `sync` pulls the node's `tinycloud.kv/sync` change feed (node feature `kv-sync-v1`) and fetches each changed value, accepting bytes only if they hash to the ETag the node attested. `get`, `list`, `status` and `reset` never touch the network, so they work with the host offline. Reads report observed state from one source host, not global finality. Needs Node.js 22.13+ or Bun (built-in SQLite); on older Node every `tinycloud replica` command fails with `RUNTIME_UNSUPPORTED` (exit 1) and other commands are unaffected.

A replica needs a device grant carrying `get` and `sync` on the prefix. Neither `*` nor `tinycloud.kv/*` implies `sync`, and the owner's default session does not hold it; `tinycloud auth grant` acquires it for that grant only:

```bash
# device
"$TC" --profile device auth request --cap tinycloud.kv:SPACE:notes/:get,list,metadata,sync --expiry 30d --emit req.json
# owner
"$TC" --profile owner auth grant req.json > grant.json
# device
"$TC" --profile device auth import grant.json
"$TC" --profile device replica sync --prefix notes/       # first sync creates the replica "notes"
"$TC" --profile device replica get notes/todo.md --raw     # offline
"$TC" --profile device replica list notes/ --json
"$TC" --profile device replica status
"$TC" --profile device replica sync                       # catch up: updates and deletes
"$TC" --profile device replica reset [--purge]
```

- The first `sync` needs `--prefix` (and `--space` when grants cover several spaces); it pins the source host (`--host` or the profile host, never a discovered local node). Later runs use the stored configuration; a different `--prefix`, `--space` or `--host` is `REPLICA_CONFIG_MISMATCH` (exit 2). `--replica <name>` selects or names a replica (default: named after the prefix, or the profile's only replica).
- The grant must be a compact UCAN issued to this device's key; SIWE/CACAO sessions cannot back a replica. A newer covering grant is installed as pending and takes over after the node accepts a sync under it. If the node refuses it, the current grant keeps serving and `status.device.pendingDelegationError` says why; a revoked replacement is discarded without touching the replica.
- Reads are allowed only inside the authority window the node attested at the last successful sync (the earliest expiry across the whole delegation chain, which can be before the grant's own `exp`), checked again when each page commits. After expiry, reads fail with `GRANT_EXPIRED` (exit 5) and no new sync starts. An authority bound that is not an RFC 3339 timestamp is `PROTOCOL_ERROR` (exit 7) and changes nothing. A revocation is learned on the next online sync, only from the node's typed revocation answer (never from text such as a key name): the replica purges its entries and content and later reads fail with `GRANT_REVOKED`, including after restart. If a content file cannot be removed, `status.purgePending` is `true` and every later `tinycloud replica` command retries; reads stay blocked meanwhile. A revoked replica stays blocked; remove it with `tinycloud replica reset --purge` and sync again under a new grant.
- `--retention-grant <cid>` presents an owner-issued `tinycloud.kv/retain` grant on the prefix (never invoked; nothing implies it). Reads then continue after the sync grant expires, marked `authority: "expired"`, until the node-attested `retainUntil`. A revocation of the retain grant a sync presented drops that grant (one set meanwhile with `--retention-grant` is kept): once the sync grant expires, reads fail with `GRANT_REVOKED`. Once the sync grant has expired the device cannot learn that the retain grant was revoked.
- Syncing the `secrets` space or a prefix in the `vault` namespace needs `--allow-secrets`.
- `get` statuses: present; `KEY_DELETED`, `KEY_ABSENT` (only once the first sync completed), `CONTENT_MISSING` (known key whose bytes are not local yet; the next sync repairs it) and `COVERAGE_INCOMPLETE` exit 4; `NOT_COVERED` (outside the prefix) exits 2. `-o FILE` writes atomically with mode 0600; stored content is re-hashed on every read unless `--no-verify`.
- Exit codes: 0 ok; 1 busy, runtime or storage error; 2 usage, `NOT_COVERED`, `SECRETS_OPT_IN_REQUIRED`; 3 grant missing; 4 key absent, deleted, content missing or coverage incomplete; 5 grant expired, revoked or not yet valid; 6 network; 7 node, protocol or integrity error (`SOURCE_CHANGED`, `SCOPE_VIOLATION`, `CONTENT_MISMATCH`); 10 storage full.
- Store: `profiles/<profile>/replicas/<name>/` (honours `TC_HOME`): `replica.db` (SQLite WAL, `synchronous=FULL`; each feed page and its cursor commit in one transaction) and content-addressed `blobs/`, directories 0700 and files 0600. Only one process syncs a replica at a time (`REPLICA_BUSY`); a process whose sync lease expired or was taken over writes nothing more. `reset --purge` removes the replica only under a live lease on the database it opened, so it never removes a replica another process took over or recreated. A node answer `410 RESET_REQUIRED` resets the replica in place and re-bootstraps from the same source; `status.lastReset` records it. A feed from a different node is `SOURCE_CHANGED` until `tinycloud replica reset` clears the pin. A profile deleted before or while any `tinycloud replica` command runs ends it with `REPLICA_NOT_FOUND`; nothing is written into the profile and it is never recreated.

## Courier

`tinycloud courier …` runs Courier, agent-to-agent threads over TinyCloud, with its own profile in `$COURIER_HOME` (default `~/.courier`); it takes no tinycloud options. See the [courier skill](../courier/SKILL.md).

## Read-through Replication Diagnostics

`--replication` enables the read-through adapter for one command;
`--no-replication` overrides `TC_REPLICATION=1`. It is off by default.
`--replication-debug` (or `TC_REPLICATION_DEBUG=1`) writes per-read, write
and sync details to stderr. The event log is
`profiles/<profile>/replication/events.jsonl` under `TC_HOME`; it records
operational metadata, not values.

`tinycloud replica report [--since 24h]` renders read source/reason counts, hit ratio,
latency and staleness percentiles, sync/write outcomes, recent divergences,
replica/grant status, and pinned keys. `--json` emits the aggregate as JSON.
`--clear-pending` clears pending replica writes and prints a warning: commits
that arrive later can be observed as stale until a subsequent sync.
`auth logout` durably denies local replica reads, removes legacy and flag-owned
files, and shreds both restorable session and key. A pending marker keeps reads
denied while startup retries erasure. A signed-out profile cannot implicitly
authenticate with its stored owner key; use explicit `auth login` for a new
session. A missing or corrupt replica gate with uncertain local writes refuses
logout without deleting credentials or files: sync first, or explicitly pass
`--discard-local-changes` to wipe both replica roots. `auth logout --revoke`
revokes verified owner-controlled stored grants and then the active session CID
online before deleting local files. Failed or ambiguous remote revoke retains
session, key and physical replica files behind a denied gate for retry.
`--keep-replicas` retains legacy files only when no replica gate, flag-owned
partition or pending purge exists; gated profiles refuse before mutation and
legacy-only keep still shreds credentials.

B-int release acceptance: test `tinycloud auth request --grant` against a real
OpenKey test account without production writes. Approve the request, confirm
the grant is stored, start a fresh process, and verify saved prefixes are
replayed and the covered read is served locally. If explicit `kv/get` plus
`sync` is rejected, stop before release and resolve the protocol contract.

## Node Health

```bash
"$TC" node health                  # Ping + latency
"$TC" node version                 # Server version
"$TC" node status                  # Combined
```

## Shell Completions

```bash
eval "$("$TC" completion bash)"
eval "$("$TC" completion zsh)"
"$TC" completion fish | source
```

## Share Publish, Inspect, Receive, List, Revoke

Publishing needs the publishing scope on a dedicated profile (`tinycloud --profile publisher auth login --device --manifest builtin:share-publishing`, or `tinycloud --profile publisher enable share`). Publish with `tinycloud --profile publisher share publish ...`.

```bash
"$TC" share publish ./note.md --json                                  # bearer link; JSON has no URL: use share show <id> --reveal-link
"$TC" share publish ./note.md --to email:alice@example.com --notify   # addressed: exact email, emailed invitation (read required)
"$TC" share publish ./note.md --to did:pkh:eip155:1:0xRecipient...    # addressed: one DID
"$TC" share publish ./note.md --to domain:example.com                 # addressed: any verified address at the domain
"$TC" share publish ./note.md --to domain:example.com --notify --notify-to alice@example.com  # invite one matching mailbox; node 1.17.3+
cat note.md | "$TC" share publish - --name note.md

printf '%s' "$SHARE_URL" | "$TC" share inspect - --json               # verify, print safe metadata
printf '%s' "$SHARE_URL" | "$TC" share receive - --stdout             # bearer link: verified bytes
printf '%s' "$SHARE_URL" | "$TC" share receive - --output .

"$TC" share list --json                                               # sender history, no complete URLs
"$TC" share show <id> [--reveal-link]
"$TC" share notify <id> --to alice@example.com                        # retry email delivery within 5 minutes of publication
"$TC" share revoke <id>                                               # bearer or addressed share this profile created
```

**Bearer vs addressed.** A bearer link (default, `--to anyone`) is `/viewer#tc1=<TinyCloud delegation>`: anyone holding the complete URL can read the file until it expires, and revocation cannot recall copies already received. Addressed links (`--to email:`, `--to did:`, `--to domain:`) are `/s/inline#v=2&p=<sealed Policy/v3 envelope>`: the content is encrypted and only the named recipient can open it after proving their email or DID in Share. `tinycloud share receive` returns the bytes of a bearer link; for an addressed link it exits 6 with `CLAIM_REQUIRED` because the recipient claims it in Share. `--notify` requires the `read` action: exact-email targets invite the matched mailbox; domain targets need `--notify-to` naming one canonical mailbox at that exact domain and a node reporting version 1.17.3 or later. The CLI refuses unsupported domain invitations before uploading or registering a share. A session-only publisher can deliver its own domain policy when the invoking DID matches its signed owner DID; a different sender DID cannot. `tinycloud share notify <id> --to <mailbox>` can address another mailbox in a domain share under the same node and sender-DID requirements; it refuses stored shares without `read` or on an unsupported node before sending.

The fragment after `#` is the read authority. It never reaches a server in a query string or HTTP request; keep complete URLs out of logs. Human publish output is exactly one URL. JSON publish output never contains the link: it retains the redacted publication fields (including the share id) and adds `notification` (the `ShareNotifyResult`, including `state`, `attempts`, and optional failure `reason`) when `--notify` was requested. To get the complete link after a `--json` publish, run `tinycloud share show <id> --reveal-link`, ideally writing it straight to a private file. Inspect never prints plaintext or secret-bearing fields. Receive uses a sanitized single-segment filename and refuses overwrite unless `--force`. `revoke` asks the owner node to revoke the share (an addressed share's Policy/v3 root, or a bearer link's delegation) and reports `revoked` only when the node confirms it; receiving the link then fails; for a bearer link, `tinycloud share receive` reports `SHARE_REVOKED` (exit 4, "This share link has been revoked by its sender."). Revoking an already revoked share keeps its original `revokedAt`. A bearer revoke that cannot proceed revokes nothing: `SHARE_ISSUER_KEY_UNAVAILABLE` (exit 5) when this profile cannot sign for the link, `SHARE_LINK_UNAVAILABLE` (exit 4) when the stored link is missing or does not match the record, and `SHARE_REVOKE_REJECTED` (exit 4, with the node's reason) when the node refuses. `SHARE_REVOKE_UNCONFIRMED` (exit 1) means the node answered without confirming: the link may already be revoked, history is not marked revoked, and you should check whether the link still opens before retrying. Pre-cutover blob-backed and plaintext `?tc2` links are not accepted.

**Notification window.** The CLI requests a stable signed delivery authorization until the earlier of share expiry and 5 minutes after its sender-history `registeredAt` timestamp. The node allows an authorization no more than 5 minutes in the future; keeping the expiry stable also makes idempotent retries use the same request. After the window, `tinycloud share notify` prints `partial-failure` (exit 9; JSON `retryable: false`, `reason: "delivery-window-expired"`) and explains that the sender must publish a new share and invite the recipient then. `share publish --notify --json` includes the same failure under `notification`. A confirmed repeat within the window prints `already-delivered`; an unconfirmed failed attempt remains retryable until the window closes. If the sender history cannot record a successful delivery confirmation, the CLI warns on stderr but preserves the successful publish/notify result; a later repeat can report `delivered` again.

**History and node preflight.** Post-publication sender-history writes wait up to 45 seconds for another process's profile lock (including stale-lock recovery). If the first history write still fails, the CLI warns and keeps its normal exit status: human output still prints the published link, but `--json` output stays redacted, and because the share was not recorded, `share show <id> --reveal-link` cannot recover it either. A later `share list`, `share notify <id>`, or `share revoke <id>` cannot find that share by ID. An immediate `--notify` can still deliver using the in-process record. Other share-command profile-lock timeouts report `PROFILE_LOCK_TIMEOUT` with a retry hint. Standalone domain notification validates the recipient and expired delivery window locally before contacting `/info`: an expired window remains exit 9 even if the node is unavailable. A node-info transport failure, including a stalled response body, is `UNAVAILABLE` (exit 4); a completed but unsupported or malformed version is `INVALID_ARGUMENT` (exit 2). Publish-time refusals say nothing was shared and no invitation was sent; standalone notify refusals say no invitation was sent.

**Concurrent history changes.** A Share command resolves its profile once for authentication and every sender-history operation, including retries; a later default-profile change cannot redirect a share link into another profile. If a write waits more than about 2 seconds to acquire the profile lock, the CLI writes one waiting notice to stderr naming that profile. A profile removed after an earlier history read or during an operation, or repeated key/salt changes, returns `SHARE_HISTORY_RETRY` (exit 1) with a retry hint; a profile missing from the outset still returns `PROFILE_NOT_FOUND` with the setup hint. If a history retry follows a revoke, check the node state before trying again: revocation might already have succeeded even though sender history could not record it.

Share publication without `--expires` requests a seven-day lifetime. For a session-only profile, the CLI clamps that request to the verified SIWE session expiry, prints a notice to stderr, and reports `"expiryClamped": true` in JSON. Explicit lifetimes beyond the session end, or with less than 60 seconds left after second-precision rounding, fail with `SESSION_LIFETIME_EXCEEDED`. Expired/invalid restored sessions and missing owner authority return `AUTH_REQUIRED`; rejected KV upload or delegation scopes return `PERMISSION_DENIED`. A session-only profile whose authority for an anyone-with-link share carries signed restrictions (caveats) is refused with `PERMISSION_DENIED` before anything is stored, because the link's delegation cannot carry the caveats; approve Share publishing without restrictions on a new profile (`tinycloud init --name publisher --key-only && tinycloud --profile publisher enable share`). Full TinyCloud storage returns the general storage-full error (`STORAGE_QUOTA_EXCEEDED` or `STORAGE_LIMIT_REACHED`, exit 10), and any other failed upload returns `UPLOAD_FAILED`; nothing is shared in either case. A filename that has characters other than `A-Z a-z 0-9 . _ -`, starts with anything but a letter or digit, contains `..`, or is longer than 128 characters is stored under a readable URI-safe name. It keeps its extension when that is 1-16 ASCII letters or digits (`Q3 plan (draft).md` is stored as `Q3-plan-draft.md`, `.env` as `share.env`); otherwise its dots become dashes, so it never gains one. Bearer links show the stored name and `receive` writes it, while addressed links keep the original. JSON publish output includes `expiryClamped: false` when no clamp was needed.

### Share Publish Options

| Flag | Description | Default |
|------|-------------|---------|
| `files` | One or more files, or `-` for bounded stdin | required |
| `--name <filename>` | Safe filename for stdin | `stdin.md` |
| `--to <target>` | `anyone`, recipient DID, email, or `domain:<name>` | `anyone` |
| `--notify` | Email the exact-email recipient, or one domain mailbox with `--notify-to`; requires `read` | off |
| `--notify-to <email>` | Canonical mailbox at the `--to domain:<name>` target (node 1.17.3+) | required for domain `--notify` |
| `--expires <duration>` | Duration: `1h`, `7d`, `1w`, or ISO date | implicit `7d`, clamped for session-only profiles |
| `--media-type <type>` | Media type for a single input | inferred |
| `--action <actions...>` | Addressed permission: `read`, `list`, or `edit` | `read` |
| `--prefix` | Publish multiple inputs beneath one addressed prefix | off |
| `--binary` | Allow non-UTF-8 bearer content | off |
| `--json` | Emit versioned redacted JSON | off |

## KV Put Input Sources (mutually exclusive)

| Source | Example |
|--------|---------|
| Argument | `tinycloud kv put key "value"` |
| File | `tinycloud kv put key --file ./data.txt` |
| Stdin | `echo "data" \| tinycloud kv put key --stdin` |

KV keys cannot contain spaces or control characters: the SDK sends keys unescaped in the node resource URI, so `get`, `put`, `head`, `delete` and `list --prefix` refuse them with `USAGE_ERROR` (exit 2) before authenticating. A `put` on full storage returns the general storage-full error (exit 10).

## Profile Directory Structure

```
~/.tinycloud/                      # 0700
├── config.json                    # Global config (defaultProfile)
├── profile-locks/
│   └── {name}/                    # Turn lock (see below); kept after `tinycloud profile delete`
│       └── .live-<dir>-<id>       # Socket of an acquisition in progress (Linux)
└── profiles/
    └── {name}/                    # 0700
        ├── profile.json           # Host, DID, chainId, ownerDid, spaceId (0600)
        ├── key.json               # Ed25519 JWK keypair (0600)
        ├── session.json           # Delegation, spaceId (0600)
        ├── additional-delegations.json        # Imported and granted delegations, with request bindings (0600)
        ├── auth-requests.json                 # Stored permission requests (0600)
        ├── delegation-binding-migration.json  # Present once unbound records were migrated (0600)
        ├── .lock/                 # Lock shared with older releases, while held
        └── cache/
```

### Profile lock

Every write to a profile (key, session, settings, delegations, permission requests) runs under the profile's lock, shared by `tinycloud` and the MCP server. Processes of this release first take a turn in `profile-locks/{name}/`, then the `profiles/{name}/.lock` directory every release uses, so they keep excluding CLI 1.0.0-beta.16 and older (which hold `.lock` from its creation) and 1.0.0-beta.17 … 1.0.1-beta.4 (which hold it once `owner.json` is linked in), and those exclude them. Among processes of this release, mutual exclusion holds however long any of them is paused, and needs no hard links (FAT/exFAT and SMB mounts work).

That guarantee assumes every process using the profile runs on the same host and in the same PID namespace (a crashed process is recognised by its PID being gone), and a filesystem whose `rename` of a directory fails when the target exists. It does not hold for a `TC_HOME` shared across machines (NFS) or between containers that do not share a PID namespace: there a live process can look crashed, have its turn or staging directory removed, and the lock can be taken twice or stop working. The one case this release handles across PID namespaces is a record that carries the checking process's own PID, below. Older releases running at the same time keep their own limits: a 1.0.0-beta.16-or-older process paused for longer than 30 s right after creating `.lock`, or a 1.0.0-beta.17 … 1.0.1-beta.4 process reclaiming `.lock` at the same moment as such a process, can still let two writers in. CLI 1.0.0-beta.16 and older never reclaim an abandoned `.lock` without an owner record; a newer release does, once it is 30 s old.

A record with the checking process's own PID says nothing by its PID: a restarted container's `tinycloud-mcp-http` is PID 1 again, and so is a live MCP server in another container sharing the volume. Owner records written by this release therefore also carry a process-wide instance ID and, on Linux, the kernel boot ID, PID namespace and process start time. Each acquisition on Linux also listens on a UNIX socket in its turn directory, `profile-locks/{name}/.live-<dir>-<id>`, whose name records that directory's device and inode, from before its first turn record until it has released the lock; the socket appears under that name only once it accepts connections. A record with this process's PID and another instance ID counts as abandoned only if it comes from the same kernel boot and one of these holds:

- It comes from the same PID namespace with a different process start time: the PID was reused. This needs no socket, and works under Bun too.
- It comes from another PID namespace, its socket was bound in the very turn directory this process uses (the same device and inode, so a bind mount of that directory qualifies), and either the socket is gone or the kernel refuses connections to it. Only the holder removes its socket, after releasing, or a process that saw it refused; the kernel refuses connections only once the holder has closed the socket or exited, so a live holder, paused or not and under any hostname, is waited for. A refusal counts only if this process can then connect to its own socket in the same directory. That catches a sandbox that refuses every connection, such as a seccomp filter returning ECONNREFUSED for all connects. It does not catch a sandbox that fabricates refusals selectively: a seccomp filter keyed on the call's arguments, a seccomp user-notification supervisor, or a BPF LSM program. The lock trusts the kernel's answers here, as its PID check trusts kill(2). A sandbox that fakes either answer can make a live holder look gone, and is unsupported. Under Bun a refusal never counts, because Bun reports a refused connection as a missing file; a removed socket does.

Every other same-PID record is waited for, as before: records from older releases; a different boot ID (the host or VM rebooted, or the volume moved to another machine); a holder that could not create its socket (a filesystem without socket files, no `/proc`); a socket bound in a different turn directory than the one this process uses (`profile-locks/` not shared while `profiles/` is, a turn directory removed and recreated, or one reached through a mount with different device numbers, such as a second mount of a network share); a checking process that cannot create its own socket or connect to it; refusals seen under Bun; and macOS and Windows. If such a record's process is gone, writes to that profile fail with `PROFILE_LOCK_TIMEOUT` (`ProfileLockTimeoutError`), without the damaged-turn detail, until it is cleared. **Only while no `tinycloud` or MCP process uses that profile**, remove its turn directory and its `.lock`:
- `tinycloud` and the stdio MCP server (`tinycloud-mcp`): `$TC_HOME/.tinycloud/profile-locks/{name}` and `$TC_HOME/.tinycloud/profiles/{name}/.lock` (without `TC_HOME`, `~/.tinycloud/…`).
- The HTTP MCP server (`tinycloud-mcp-http`, the container image), for each affected tenant: `$TC_MCP_STATE_DIR/tenants/{tenant}/.tinycloud/profile-locks/agent` and `$TC_MCP_STATE_DIR/tenants/{tenant}/.tinycloud/profiles/agent/.lock` (`TC_MCP_STATE_DIR` is `/var/lib/tinycloud-mcp` in the image).

Never remove a `.live-*` socket or a turn directory while a process may hold the lock: a removed socket counts as a finished holder. Sockets left by processes that are gone are removed by a later acquisition (under Node) once the kernel refuses them.

A crashed holder's lock is reclaimed automatically (`.lock` once 30 s old). With hard links, dead-owner recovery keeps a `.recover-*` claim inside `.lock` until it finishes; it never unlinks or moves a newly published live owner, and a failed claim never removes another writer's empty `.lock`. A crashed current-release recoverer may leave only a `.recover-*` claim. Releases through 1.0.1-beta.4 cannot reclaim it even after it ages. A current-release command that acquires the affected profile's lock processes the claim, restoring a live owner's record if it contains one.

On either recovery path, an orphaned `.recover-*` claim can hold a replacement owner's live record: the hard-link path may claim it before detecting a mismatch, and the no-hard-links path may move it before putting it back. If the recoverer crashes and that holder releases while its process stays alive, the next acquisition restores the claimed record as `owner.json`. Acquisition can then remain blocked until the PID exits **and** the record is at least 30 s old—for a long-lived MCP server, possibly until it restarts. This costs availability only; it never admits a second holder. To clear the stalled profile manually, remove its `profiles/{name}/.lock` **only when no `tinycloud` or MCP process is running**.

`PROFILE_LOCK_TIMEOUT` naming `profile-locks/{name}` means its turn lock is damaged (for example by a disk error): when no `tinycloud` or MCP process is using that profile, remove `~/.tinycloud/profile-locks/{name}`; it is recreated on the next write. A write that waited for the lock while `tinycloud profile delete` removed the profile fails with `PROFILE_NOT_FOUND` instead of recreating it.

## DID Formats

- **Session key**: `did:key:z6Mk...#z6Mk...` — generated at init
- **Owner DID**: `did:pkh:eip155:{chainId}:{address}` — after auth

Use `--json` for machine-readable output; interactive commands can render human output. General command errors go to stderr as `{error: {code, message, hint?, recovery?, setup?, progress?, meta?, warnings?}}` (`recovery`, `setup` and `progress` are described under [Secrets](#asking-the-owner-for-a-secret-request-wait-manage)). `meta` contains a typed HTTP `status` and, only when validated as a TinyCloud capability (and against the KV request when available), a `resource` and `requiredAction`. Inspect the structured code, not only the exit status.

General storage/auth exit codes: 0 success, 1 operation error (including `PROFILE_MIGRATION_REQUIRED` and `PROBE_FAILED`), 2 invalid input, 3 authentication required, 4 not found, 5 permission denied, 6 network error, 7 node error, 8 pending (`tinycloud secrets wait` only), 10 storage full, 130 interrupted (`CANCELLED`). `tinycloud share` uses its own: 1 profile lock timeout, sender-history retry or unconfirmed revocation (`PROFILE_LOCK_TIMEOUT`, `SHARE_HISTORY_RETRY`, `SHARE_REVOKE_UNCONFIRMED`), 3 upload authority required, 4 unavailable, expired, revoked bearer link, upload failed or revocation refused (`SHARE_LINK_UNAVAILABLE`, `SHARE_REVOKED`, `SHARE_REVOKE_REJECTED`), 5 permission denied (`PERMISSION_DENIED`, `SHARE_ISSUER_KEY_UNAVAILABLE`) or verification failed, 6 recipient authorization required or network error, 7 byte limit, 8 output conflict or unsafe filename, 9 partial success, 10 storage full.

For `tinycloud kv get|put|head|list|delete`, `tinycloud space list|host`, `tinycloud sql`, `tinycloud vault`, `tinycloud vars`, `tinycloud duckdb`, `tinycloud secrets list|put|delete`, `tinycloud delegation`, and `tinycloud account`, service-result errors use typed authorization: a plain HTTP 401 is `AUTH_REQUIRED` (exit 3); a 403 is `PERMISSION_DENIED` (exit 5). A 401 with a validated missing capability, or `AUTH_UNAUTHORIZED` without an HTTP status, is `PERMISSION_DENIED` (exit 5); a validated capability also produces a `tinycloud auth request --cap` hint. This changes the former exit 1 for status-less `AUTH_UNAUTHORIZED` in the listed commands. Other HTTP failures retain their service-specific codes. `tinycloud share` has separate exit mappings below.

Every command that writes reports full TinyCloud storage the same way: `STORAGE_QUOTA_EXCEEDED` (storage is full) or `STORAGE_LIMIT_REACHED` (this write is larger than what is left), exit 10, with nothing written (`tinycloud sql copy` instead names the table and the rows it had already copied). The hint gives the account totals when the node reports them (`371.7 MiB used of 100 MiB (free plan)`), says reading still works, and links to https://account.tinycloud.xyz/billing. Retrying cannot succeed until the owner frees up space or upgrades.
