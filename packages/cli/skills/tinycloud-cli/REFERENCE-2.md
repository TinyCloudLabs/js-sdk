# CLI Command Reference, part 2: secrets, local replicas and replication diagnostics

Part 2 of the CLI command reference. The entry point is [REFERENCE.md](REFERENCE.md), which has the context, login, delegations, spaces and profiles.

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
tinycloud secrets network init
tinycloud secrets network show
tinycloud secrets network grant did:pkh:eip155:1:0xRecipient...

printf '%s' "$ANTHROPIC_API_KEY" | tinycloud secrets put ANTHROPIC_API_KEY --stdin   # keeps the value out of argv and shell history
tinycloud secrets get ANTHROPIC_API_KEY
tinycloud secrets get ANTHROPIC_API_KEY -o key.txt   # atomic owner-only (0600) replacement
tinycloud secrets list
tinycloud secrets delete ANTHROPIC_API_KEY
```

A missing secret makes `tinycloud secrets get` exit 4 (`NOT_FOUND`). For an identity that is not local, `error.setup` carries the owner's request link; a local identity (or a name/scope no link can express) gets only a hint naming `tinycloud secrets put NAME --stdin`. `tinycloud secrets doctor NAME` hints `tinycloud secrets request NAME` for a missing secret, or `tinycloud secrets put NAME --stdin` for a local identity. `tinycloud secrets get --delegation` follows the same rule, and a delegated read the node refuses (403, a capability 401, `AUTH_UNAUTHORIZED`) exits 5.

### Running a command with secrets: `run`

```bash
tinycloud secrets run NAME... [--map NAME=ENV_VAR]... [--scope S] [--space S] [--delegation SOURCE] [--private-key HEX] -- <command> [args...]
tinycloud --profile agent secrets run OPENAI_API_KEY -- python train.py
tinycloud --profile agent secrets run --map ANTHROPIC_KEY=ANTHROPIC_API_KEY -- node server.js
```

`tinycloud secrets run` reads every named secret as `tinycloud secrets get` does, then starts `<command>` directly, without a shell, with each value in its environment: under the secret's name, or under `ENV_VAR` for `--map NAME=ENV_VAR`. A value replaces an inherited variable of the same name. The CLI doesn't pass its own `TC_PRIVATE_KEY` to the command. To give the command a key from a secret, use `--map NAME=TC_PRIVATE_KEY`. Everything after the first `--`, including any further `--`, goes to the command unchanged. The command uses the CLI's stdin, stdout and stderr; the CLI itself writes nothing to stdout, and its own messages go to stderr.

- Name at least one secret, as an argument or with `--map`. `ENV_VAR` must match `[A-Za-z_][A-Za-z0-9_]*`; two secrets mapped to the same variable, no `--`, or nothing after it exit 2 (`USAGE_ERROR`) before any read.
- If any secret cannot be read, the command does not start and the CLI exits with the code and error `tinycloud secrets get` gives for that secret. A value containing a NUL character exits 1 (`SECRET_NOT_EXPORTABLE`) without starting the command.
- Otherwise the CLI exits with the command's exit code. If the command was ended by SIGINT, SIGTERM, SIGHUP, SIGKILL, SIGALRM or SIGUSR2, the CLI ends by the same signal (or exits with 128 plus the signal number if that signal doesn't end it). If any other signal ended it, such as SIGQUIT or SIGSEGV, the CLI exits with 128 plus the signal number instead, so it does not cause a core dump (SIGUSR1 and SIGPIPE are left out too: Node uses SIGUSR1 for its inspector and ignores SIGPIPE).
- SIGINT, SIGTERM, SIGHUP and SIGQUIT sent to the CLI go to the command. When the CLI runs in the foreground of a terminal, it doesn't pass on SIGINT, SIGQUIT or SIGHUP: the terminal already sends them (Ctrl-C, Ctrl-\, hangup) to the command, so the command normally gets each one once. The CLI checks whether it's in the foreground using `/proc`, or `ps` where `/proc` isn't available. If neither works, it passes the signals on. When the CLI runs in the background, it passes them on, so a signal sent to the whole job (for example `kill -INT %1`) can reach the command twice.
- From a script, stop the command by sending SIGTERM to the CLI's process ID. The CLI passes it on, waits for the command to exit, then exits the way the command did (the command's own exit code if it handles SIGTERM itself). If the command ignores SIGTERM, the CLI keeps waiting.
- A command that does not exist exits 127; one that cannot be executed, or cannot be started for another reason, exits 126. These cases print one plain stderr line even with `--json`: `tinycloud secrets run: <command>: command not found`, `…: permission denied` or `…: cannot run (<error code>)`.

Limits: `tinycloud secrets run` keeps values out of the command line, your shell history and the CLI's own output. It doesn't hide them from the command: the command, and anything it starts, receives the values and can print, log or pass them on. Other programs running as the same user can often read a process's environment too.

### Asking the owner for a secret: `request`, `wait`, `manage`

`/usr/sbin/tc` (iproute2 traffic control) can shadow the older `tc` name on `PATH`, so scripts call the CLI by absolute path:

```bash
tinycloud --profile agent secrets request OPENAI_API_KEY --requester "agent@host" --json
# {"url":"https://secrets.tinycloud.xyz/request?owner=…&name=OPENAI_API_KEY&requester=…&v=1","names":["OPENAI_API_KEY"],"owner":"did:pkh:eip155:1:0x…"}
# send the url to the owner once, then:
tinycloud --profile agent secrets wait OPENAI_API_KEY --timeout 9m --json
tinycloud --profile agent secrets get OPENAI_API_KEY --raw
tinycloud secrets manage OPENAI_API_KEY --no-open --json   # {"url":"…","opened":false}: the replace/manage page
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

An agent profile gets read access to named secrets through a scoped OpenKey paste login with a manifest that names them; [AUTH-2.md](AUTH-2.md#secret-reads-for-an-agent) has the full flow. Device login cannot grant secrets.

```bash
echo '{ "app_id": "my.agent", "space": "secrets", "secrets": { "OPENAI_API_KEY": true } }' > agent.json
tinycloud init --name agent --key-only
tinycloud --profile agent auth login --method openkey --paste --manifest agent.json --owner did:pkh:eip155:1:0xOWNER < /dev/null
# exits 3 (PASTE_CODE_MISSING) and names the approval URL; the owner approves and returns a code
printf '%s\n' "$CODE" | tinycloud --profile agent auth login --method openkey --paste --manifest agent.json --owner did:pkh:eip155:1:0xOWNER
tinycloud --profile agent secrets get OPENAI_API_KEY --raw
```

`secrets: { NAME: true }` requests, in the owner's `secrets` space, `kv/get` on `vault/secrets/NAME` and `capabilities/read` on `""`, plus the raw network entry `{ "service": "tinycloud.encryption", "space": "encryption", "path": "urn:tinycloud:encryption:<ownerDid>:default", "actions": ["tinycloud.encryption/decrypt"] }`. The owner DID comes from the profile's recorded owner, else `--owner`, and its address is EIP-55 checksummed in the URN; with neither the login fails with `OWNER_DID_UNKNOWN`. The JSON result lists approved `permissions` and `declined` entries. A decrypt signed inside the owner's space by an older OpenKey deployment is not a raw grant: scoped login reports it in `declined` and omits it from saved permissions. Browser `auth request --grant` or secret-read escalation refuses that old nested proof before activating or storing a grant (`OPENKEY_GRANT_BROADENED`); a renewed approval must sign the raw network grant.

When neither stdin nor stderr is a terminal, `secrets get|list|put|delete` on an OpenKey profile that lacks the grant fails with `PERMISSION_DENIED` (exit 5) and a scoped paste-login hint. Missing or expired sessions instead fail with `AUTH_REQUIRED` (exit 3) before a canonical read invokes the node or starts an unscoped browser refresh. On any profile kind, a stored session that has expired (a signed session, or one `tinycloud auth import` created from a compact UCAN) or no longer verifies fails with `AUTH_REQUIRED` (exit 3) and a sign-in hint before any node request, never as a retryable `NODE_ERROR`; operations and MCP report a non-retryable `AUTH_REQUIRED`. Any service result coded `AUTH_REQUIRED` or `PERMISSION_DENIED` without an HTTP status now exits 3 or 5 instead of 1 in commands using `cliErrorFromService` (account, delegation, DuckDB, encryption, KV, secrets, SQL, and vars); this preserves operation auth codes as typed errors.

## Local Replicas

`tinycloud replica` keeps a durable, read-only copy of one KV prefix on this device. `sync` pulls the node's `tinycloud.kv/sync` change feed (node feature `kv-sync-v1`) and fetches each changed value, accepting bytes only if they hash to the ETag the node attested. `get`, `list`, `status` and `reset` never touch the network, so they work with the host offline. Reads report observed state from one source host, not global finality. Needs Node.js 22.20 or later, or Bun (built-in SQLite); on older Node every `tinycloud replica` command fails with `RUNTIME_UNSUPPORTED` (exit 1) and other commands are unaffected.

A replica needs a device grant carrying `get` and `sync` on the prefix. Neither `*` nor `tinycloud.kv/*` implies `sync`, and the owner's default session does not hold it; `tinycloud auth grant` acquires it for that grant only:

```bash
# device
tinycloud --profile device auth request --cap tinycloud.kv:SPACE:notes/:get,list,metadata,sync --expiry 30d --emit req.json
# owner
tinycloud --profile owner auth grant req.json > grant.json
# device
tinycloud --profile device auth import grant.json
tinycloud --profile device replica sync --prefix notes/       # first sync creates the replica "notes"
tinycloud --profile device replica get notes/todo.md --raw     # offline
tinycloud --profile device replica list notes/ --json
tinycloud --profile device replica status
tinycloud --profile device replica sync                       # catch up: updates and deletes
tinycloud --profile device replica reset [--purge]
```

- The first `sync` needs `--prefix` (and `--space` when grants cover several spaces); it pins the source host (`--host` or the profile host, never a discovered local node). Later runs use the stored configuration; a different `--prefix`, `--space` or `--host` is `REPLICA_CONFIG_MISMATCH` (exit 2). `--replica <name>` selects or names a replica (default: named after the prefix, or the profile's only replica).
- The grant must be a compact UCAN issued to this device's key; SIWE/CACAO sessions cannot back a replica. A newer covering grant is installed as pending and takes over after the node accepts a sync under it. If the node refuses it, the current grant keeps serving and `status.device.pendingDelegationError` says why; a revoked replacement is discarded without touching the replica.
- Reads are allowed only inside the authority window the node attested at the last successful sync (the earliest expiry across the whole delegation chain, which can be before the grant's own `exp`), checked again when each page commits. After expiry, reads fail with `GRANT_EXPIRED` (exit 5) and no new sync starts. An authority bound that is not an RFC 3339 timestamp is `PROTOCOL_ERROR` (exit 7) and changes nothing. A revocation is learned on the next online sync, only from the node's typed revocation answer (never from text such as a key name): the replica purges its entries and content and later reads fail with `GRANT_REVOKED`, including after restart. If a content file cannot be removed, `status.purgePending` is `true` and every later `tinycloud replica` command retries; reads stay blocked meanwhile. A revoked replica stays blocked; remove it with `tinycloud replica reset --purge` and sync again under a new grant.
- `--retention-grant <cid>` presents an owner-issued `tinycloud.kv/retain` grant on the prefix (never invoked; nothing implies it). Reads then continue after the sync grant expires, marked `authority: "expired"`, until the node-attested `retainUntil`. A revocation of the retain grant a sync presented drops that grant (one set meanwhile with `--retention-grant` is kept): once the sync grant expires, reads fail with `GRANT_REVOKED`. Once the sync grant has expired the device cannot learn that the retain grant was revoked.
- Syncing the `secrets` space or a prefix in the `vault` namespace needs `--allow-secrets`.
- `get` statuses: present; `KEY_DELETED`, `KEY_ABSENT` (only once the first sync completed), `CONTENT_MISSING` (known key whose bytes are not local yet; the next sync repairs it) and `COVERAGE_INCOMPLETE` exit 4; `NOT_COVERED` (outside the prefix) exits 2. `-o FILE` writes atomically with mode 0600; stored content is re-hashed on every read unless `--no-verify`.
- Exit codes: 0 ok; 1 busy, runtime or storage error; 2 usage, `NOT_COVERED`, `SECRETS_OPT_IN_REQUIRED`; 3 grant missing; 4 key absent, deleted, content missing or coverage incomplete; 5 grant expired, revoked or not yet valid; 6 network; 7 node, protocol or integrity error (`SOURCE_CHANGED`, `SCOPE_VIOLATION`, `CONTENT_MISMATCH`); 10 storage full.
- Store: `profiles/<profile>/replicas/<name>/` (honours `TC_HOME`): `replica.db` (SQLite WAL, `synchronous=FULL`; each feed page and its cursor commit in one transaction) and content-addressed `blobs/`, directories 0700 and files 0600. Only one process syncs a replica at a time (`REPLICA_BUSY`); a process whose sync lease expired or was taken over writes nothing more. `reset --purge` removes the replica only under a live lease on the database it opened, so it never removes a replica another process took over or recreated. A node answer `410 RESET_REQUIRED` resets the replica in place and re-bootstraps from the same source; `status.lastReset` records it. A feed from a different node is `SOURCE_CHANGED` until `tinycloud replica reset` clears the pin. A profile deleted before or while any `tinycloud replica` command runs ends it with `REPLICA_NOT_FOUND`; nothing is written into the profile and it is never recreated.

## Read-through Replication Diagnostics

`--replication` enables the read-through adapter for one command;
`--no-replication` overrides `TC_REPLICATION=1`. It is off by default.
`--replication-debug` (or `TC_REPLICATION_DEBUG=1`) writes per-read, write
and sync details to stderr. The event log is
`profiles/<profile>/replication/events.jsonl` under `TC_HOME`; it records
operational metadata, not values.

`tinycloud replica report [--since 24h]` reads persisted event and identity
partition files only. It renders read source/reason counts, hit ratio, latency
and staleness percentiles, sync/write outcomes, and recent divergences; JSON
marks live replica status unavailable. It never starts a replication runtime.
Report `--purge` and `--clear-pending` refuse with exit 2 `REPORT_READ_ONLY`.
`tinycloud replica reset --replica <name> --purge` is a partial alternative
for a named local replica only. Flag-owned purge and pending clearing have no
equivalent yet (TC-1309).
On macOS and Windows, `replica reset --purge` and `auth logout` with a legacy
`replicas/` tree refuse local removal rather than delete through an unpinned
path. The existing files are retained.
`auth logout` durably denies local replica reads, removes legacy and flag-owned
files, and shreds both restorable session and key. A pending marker keeps reads
denied while startup retries erasure. A signed-out profile cannot implicitly
authenticate with its stored owner key; use explicit `auth login` for a new
session. An unknown replica path, an unverified legacy SQLite schema, or an
unreadable gate refuses logout before a marker, credential deletion or node
request. Sync first, or pass `--discard-local-changes` to approve the displayed
paths, types and file identities. New or changed entries need fresh approval.
With a verified local-owner key, `auth logout --revoke --discard-local-changes`
preserves session, key and physical replicas through every online exact-CID
receipt; partial failure leaves them behind a durable denied marker for retry.
After a failed revoke, plain logout compares the original approved inventory
first. Changed paths refuse even with `--discard-local-changes`, retain all
credentials and files, and print a 32-hex-character token. A separate
`auth logout --discard-local-changes --approve-inventory <token>` approves
only the newly displayed identities; further changes invalidate the token.
After full remote success, cleanup shreds credentials and erases only approved
entries. A later inventory mismatch retains the marker and remaining files;
repeat `auth logout --discard-local-changes` for fresh approval without
repeating node revocations. OpenKey
owner revocation currently fails closed with `REVOCATION_AUTHORITY_UNAVAILABLE`,
retaining credentials and denied replica files until signed owner revoke
authority is supported.
When the replica gate belongs to a different account than the signed-in
session, logout signs that session out and removes only the profile's legacy
`replicas/` tree; the other account's gate and flag-owned replicas stay. An
interrupted earlier sign-out is reported, and a second `auth logout` completes
it. A gate that no longer matches its logout record (for example, restored
from an older copy) refuses logout; run `tinycloud profile delete <name>` (after
`tinycloud profile switch <other>` if it is the default) and sign in again.

`--keep-replicas` retains legacy files only when no replica gate, flag-owned
partition or pending purge exists; gated profiles refuse before mutation and
legacy-only keep still shreds credentials.

B-int release acceptance: test `tinycloud auth request --grant` against a real
OpenKey test account without production writes. Approve the request, confirm
the grant is stored, start a fresh process, and verify saved prefixes are
replayed and the covered read is served locally. If explicit `kv/get` plus
`sync` is rejected, stop before release and resolve the protocol contract.
