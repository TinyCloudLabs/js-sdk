# TC CLI Command Reference

<!-- BEGIN GENERATED TINYCloud operations coverage -->
This release has **Commander coverage tracked, not complete parity**:

- 1 migrated registration(s).
- 1 partially migrated registration(s).
- 123 legacy registration(s) remain Commander-owned.

- `auth import [source]` → `tinycloud.auth.import@1` (partial; legacy inputs: v1 delegation artifact, v1 permission artifact without command, bare portable delegation, stored delegation wrapper, cross-user delegation persisted with activated=false).
- `secrets get <name>` → `tinycloud.secrets.get@1` (migrated).
<!-- END GENERATED TINYCloud operations coverage -->

## Calling the CLI

`/usr/sbin/tc` (iproute2 traffic control) shadows TinyCloud's `tc` on many Linux hosts. Call the CLI by absolute path: `TC="$(npm prefix --global)/bin/tc"; "$TC" --version`.

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
tc profile list                    # use a new profile name; keep existing profiles
tc init --name publisher --key-only
tc --profile publisher auth login --device --manifest builtin:share-publishing --expiry 7d
tc --profile publisher context --json
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

Device login JSON lists the signed, approved `permissions`, owner-unchecked `declined` capabilities, `ownerDid`, `spaceId` and `expiresAt`. `tc auth request --manifest FILE --grant --device` adds another space to a logged-in profile the same way (default lifetime 7d). `tc enable share [--replace-session]` is shorthand for device login with `builtin:share-publishing`. OpenKey refuses `tinycloud.sql` and other abilities outside its device policy; use browser login (`--method openkey --manifest`) for those. Non-interactive browser login without `--paste` or `--no-popup` fails fast with `INTERACTIVE_LOGIN_REQUIRED`. Only an explicit `--host` is stored on the profile. Errors: `MANIFEST_REQUIRED`, `SCOPE_REJECTED` (OpenKey refused a capability; the message names it), `SESSION_IN_USE` (the request or the approved scope would narrow a live session; use a new profile or `--replace-session`), `PROFILE_CHANGED_DURING_LOGIN` (another login, key rotation or logout changed the profile while approval was pending; nothing saved), `PROFILE_STATE_INCONSISTENT` (profile, key and session disagree after an interrupted write; `--replace-session` or a new profile), `PROFILE_LOCK_TIMEOUT` (another process held the profile lock past 45 s), `LOCAL_OWNER_PROFILE` (scoped or device login on a local-owner-key profile; use a separate profile), `OPENKEY_UNREACHABLE`, `DEVICE_AUTH_DENIED`, `DEVICE_AUTH_EXPIRED`, `DEVICE_AUTH_BINDING_MISMATCH` (OpenKey's approval metadata disagrees with the signed grant), `OPENKEY_OWNER_MISMATCH`, `OPENKEY_GRANT_BROADENED`, `OPENKEY_EXPIRY_EXCEEDED` (the signed session outlives `--expiry`). Owner addresses compare case-insensitively (EIP-55 or lowercase); chain id and space name compare exactly. See [AUTH.md](AUTH.md).

`builtin:share-publishing` requests, in the owner's `default` space, exactly:

| Prefix | Abilities | Why |
|------|-------------|-----|
| `""` (space root) | `capabilities/read` | required by OpenKey to sign any delegation; lets the CLI read its own capability set |
| `xyz.tinycloud.share/shares/` | `kv/put` | store a bearer link's source |
| | `kv/get` | mint the link's read-only child delegation (a session delegates only what it holds) |
| `shares/` | `kv/put` | store an addressed share's encrypted source; `--action edit` |
| | `kv/get`, `kv/metadata` | back the Policy/v3 root that grants recipients read; `--notify` delivery authorization |
| | `kv/list` | `--action list` on a `--prefix` share |

No `del` anywhere and no `list` on the bearer prefix: no `tc share` command uses them. Inspect and receive use the link's own authority. Revoke signs `tinycloud.delegation/revoke` over the delegation's own CID and a Policy/v3 root revocation with the issuing session key, not a space capability. OpenKey shows the capability read as required (not uncheckable), so it is always in the signed grant and never in `declined`.

## Delegations

```bash
tc delegation create \
  --to did:pkh:eip155:1:0xRecipient... \
  --path kv/shared \
  --actions kv/get,kv/put \
  --expiry 24h

tc delegation list              # All
tc delegation list --granted    # Granted by me
tc delegation list --received   # Received by me
tc delegation info <cid>
tc delegation revoke <cid>
```

Actions are auto-prefixed with `tinycloud.` if not already.

`tc auth import` stores delegations in the profile's `additional-delegations.json`; a compact-UCAN delegation addressed to the profile's session key is stored with an `authorityRequest` binding. Later commands install such a delegation only when its signed capabilities fit inside that binding. [AUTH.md](AUTH.md#imported-delegations-and-their-request-bindings) describes how each import route binds a delegation, the one-time migration of records from earlier releases, and how to recover a record that installs nothing.

## Spaces

```bash
tc space list
tc space create myspace
tc space info                   # Current space
tc space info <space-id>        # Specific space
tc space switch myspace
```

## Profiles

Multiple identities/environments with isolated keys and sessions.

```bash
tc profile list
tc profile create staging --host https://staging.tinycloud.xyz
tc profile show                 # Current profile
tc profile switch staging       # Change default
tc profile delete old-profile
```

Per-command override: `tc kv get mykey --profile staging`

## Secrets

Secrets are stored as network-encrypted inline envelopes and read through
`tinycloud.encryption/decrypt`. Secret names are env-style uppercase
identifiers such as `FIREFLIES_API_KEY`. `tc secrets network show` accepts
either a short network name or a full
`urn:tinycloud:encryption:<ownerDid>:<network>` identifier, and `tc secrets
network grant` takes the short name, resolves the network, and issues
`tinycloud.encryption/decrypt` on that network. Share the decrypt grant
separately from any KV or SQL reads the app also needs.

```bash
tc secrets network init
tc secrets network show
tc secrets network grant did:pkh:eip155:1:0xRecipient...

tc secrets put ANTHROPIC_API_KEY "sk-..."
tc secrets get ANTHROPIC_API_KEY
tc secrets get ANTHROPIC_API_KEY -o key.txt   # atomic owner-only (0600) replacement
tc secrets list
tc secrets delete ANTHROPIC_API_KEY
```

### Scoped secret reads for agents

An agent profile gets read access to named secrets through a scoped OpenKey paste login with a manifest that names them; [AUTH.md](AUTH.md#secret-reads-for-an-agent) has the full flow. Device login cannot grant secrets.

```bash
echo '{ "app_id": "my.agent", "space": "secrets", "secrets": { "OPENAI_API_KEY": true } }' > agent.json
tc init --name agent --key-only
tc --profile agent auth login --method openkey --paste --manifest agent.json --owner did:pkh:eip155:1:0xOWNER < /dev/null
# exits 3 (PASTE_CODE_MISSING) and names the approval URL; the owner approves and returns a code
printf '%s\n' "$CODE" | tc --profile agent auth login --method openkey --paste --manifest agent.json --owner did:pkh:eip155:1:0xOWNER
tc --profile agent secrets get OPENAI_API_KEY --raw
```

`secrets: { NAME: true }` requests, in the owner's `secrets` space, `kv/get` on `vault/secrets/NAME` and `capabilities/read` on `""`, plus the raw network entry `{ "service": "tinycloud.encryption", "space": "encryption", "path": "urn:tinycloud:encryption:<ownerDid>:default", "actions": ["tinycloud.encryption/decrypt"] }`. The owner DID comes from the profile's recorded owner, else `--owner`, and its address is EIP-55 checksummed in the URN; with neither the login fails with `OWNER_DID_UNKNOWN`. The JSON result lists approved `permissions` and `declined` entries. A decrypt signed inside the owner's space by an older OpenKey deployment is not a raw grant: scoped login reports it in `declined` and omits it from saved permissions. Browser `auth request --grant` or secret-read escalation refuses that old nested proof before activating or storing a grant (`OPENKEY_GRANT_BROADENED`); a renewed approval must sign the raw network grant.

When neither stdin nor stderr is a terminal, `secrets get|list|put|delete` on an OpenKey profile that lacks the grant fails with `PERMISSION_DENIED` (exit 5) and a scoped paste-login hint. Missing or expired sessions instead fail with `AUTH_REQUIRED` (exit 3) before a canonical read invokes the node or starts an unscoped browser refresh. On any profile kind, a stored signed session that has expired or no longer verifies fails with `AUTH_REQUIRED` (exit 3) and a sign-in hint before any node request, never as a retryable `NODE_ERROR`; operations and MCP report a non-retryable `AUTH_REQUIRED`. Any service result coded `AUTH_REQUIRED` or `PERMISSION_DENIED` without an HTTP status now exits 3 or 5 instead of 1 in commands using `cliErrorFromService` (account, delegation, duckdb, kv, secrets list/put/delete, space, sql, vars and vault); for example, `tc secrets list` without a grant returns the NodeSecretsService's status-less `PERMISSION_DENIED` with exit 5. `tc secrets get` and `tc auth import` additionally supply the profile kind's sign-in hint for `AUTH_REQUIRED`. A delegate session bootstrapped by `tc auth import` stores no SIWE or expiry, so its expiry is found only when the node refuses it. At a terminal, the owner approves a missing grant in OpenKey: the request adds `tinycloud.capabilities/read` on the space root and keeps raw decrypt in the `encryption` pseudo-space, and a decrypt-only request is placed in the secrets space. The grant is stored with its signed SIWE proof and bound to exactly its signed capabilities, and `secrets get` (like every operation, including MCP) re-verifies it against the session key and owner, and holds it to that binding, in the same process or a new one; a stored grant that fails (such as one from an earlier release, stored without a proof) is skipped and reported as a `STORED_GRANT_SKIPPED` warning with a fixed reason code and its CID when that CID is the CID of the stored bytes: inside the JSON error's `warnings` (including a failed `-o` write), as one `{"warnings": [...]}` stderr line after a successful read's output, or as one human-readable stderr line. `--json` selects the JSON forms even with stdout on a terminal, and suppresses progress spinners. Expired grants are dropped silently. Operations and MCP results carry the same `warnings` array. A JSON error can carry both `meta` (validated authorization fields) and `warnings`. A canonical `secrets get` that still lacks authority fails with `PERMISSION_DENIED` (exit 5). Redirected stdout alone does not disable an owner's browser approval; its URL appears on stderr and terminal stdin accepts a code. `secrets get -o` validates the destination and existing directory before any read or decrypt, then syncs a fresh 0600 inode and atomically replaces an existing regular file. Directory sync is best-effort after replacement and cannot turn a completed write into a reported failure. It refuses symlinks, directories, devices and absent parent directories (`INVALID_ARGUMENT`); an unreplaceable filesystem target fails with a sanitized error naming the destination, without a non-atomic fallback. A node that refuses decrypt (HTTP 401/403) is reported as missing authority on the invoked network, not as an undecryptable secret.

## Local Replicas

`tc replica` keeps a durable, read-only copy of one KV prefix on this device. `sync` pulls the node's `tinycloud.kv/sync` change feed (node feature `kv-sync-v1`) and fetches each changed value, accepting bytes only if they hash to the ETag the node attested. `get`, `list`, `status` and `reset` never touch the network, so they work with the host offline. Reads report observed state from one source host, not global finality. Needs Node.js 22.13+ or Bun (built-in SQLite); on older Node every `tc replica` command fails with `RUNTIME_UNSUPPORTED` (exit 1) and other commands are unaffected.

A replica needs a device grant carrying `get` and `sync` on the prefix. Neither `*` nor `tinycloud.kv/*` implies `sync`, and the owner's default session does not hold it; `tc auth grant` acquires it for that grant only:

```bash
# device
tc --profile device auth request --cap tinycloud.kv:SPACE:notes/:get,list,metadata,sync --expiry 30d --emit req.json
# owner
tc --profile owner auth grant req.json > grant.json
# device
tc --profile device auth import grant.json
tc --profile device replica sync --prefix notes/       # first sync creates the replica "notes"
tc --profile device replica get notes/todo.md --raw     # offline
tc --profile device replica list notes/ --json
tc --profile device replica status
tc --profile device replica sync                       # catch up: updates and deletes
tc --profile device replica reset [--purge]
```

- The first `sync` needs `--prefix` (and `--space` when grants cover several spaces); it pins the source host (`--host` or the profile host, never a discovered local node). Later runs use the stored configuration; a different `--prefix`, `--space` or `--host` is `REPLICA_CONFIG_MISMATCH` (exit 2). `--replica <name>` selects or names a replica (default: named after the prefix, or the profile's only replica).
- The grant must be a compact UCAN issued to this device's key; SIWE/CACAO sessions cannot back a replica. A newer covering grant is installed as pending and takes over after the node accepts a sync under it. If the node refuses it, the current grant keeps serving and `status.device.pendingDelegationError` says why; a revoked replacement is discarded without touching the replica.
- Reads are allowed only inside the authority window the node attested at the last successful sync (the earliest expiry across the whole delegation chain, which can be before the grant's own `exp`), checked again when each page commits. After expiry, reads fail with `GRANT_EXPIRED` (exit 5) and no new sync starts. An authority bound that is not an RFC 3339 timestamp is `PROTOCOL_ERROR` (exit 7) and changes nothing. A revocation is learned on the next online sync, only from the node's typed revocation answer (never from text such as a key name): the replica purges its entries and content and later reads fail with `GRANT_REVOKED`, including after restart. If a content file cannot be removed, `status.purgePending` is `true` and every later `tc replica` command retries; reads stay blocked meanwhile. A revoked replica stays blocked; remove it with `tc replica reset --purge` and sync again under a new grant.
- `--retention-grant <cid>` presents an owner-issued `tinycloud.kv/retain` grant on the prefix (never invoked; nothing implies it). Reads then continue after the sync grant expires, marked `authority: "expired"`, until the node-attested `retainUntil`. A revocation of the retain grant a sync presented drops that grant (one set meanwhile with `--retention-grant` is kept): once the sync grant expires, reads fail with `GRANT_REVOKED`. Once the sync grant has expired the device cannot learn that the retain grant was revoked.
- Syncing the `secrets` space or a prefix in the `vault` namespace needs `--allow-secrets`.
- `get` statuses: present; `KEY_DELETED`, `KEY_ABSENT` (only once the first sync completed), `CONTENT_MISSING` (known key whose bytes are not local yet; the next sync repairs it) and `COVERAGE_INCOMPLETE` exit 4; `NOT_COVERED` (outside the prefix) exits 2. `-o FILE` writes atomically with mode 0600; stored content is re-hashed on every read unless `--no-verify`.
- Exit codes: 0 ok; 1 busy, runtime or storage error; 2 usage, `NOT_COVERED`, `SECRETS_OPT_IN_REQUIRED`; 3 grant missing; 4 key absent, deleted, content missing or coverage incomplete; 5 grant expired, revoked or not yet valid; 6 network; 7 node, protocol or integrity error (`SOURCE_CHANGED`, `SCOPE_VIOLATION`, `CONTENT_MISMATCH`); 10 storage full.
- Store: `profiles/<profile>/replicas/<name>/` (honours `TC_HOME`): `replica.db` (SQLite WAL, `synchronous=FULL`; each feed page and its cursor commit in one transaction) and content-addressed `blobs/`, directories 0700 and files 0600. Only one process syncs a replica at a time (`REPLICA_BUSY`); a process whose sync lease expired or was taken over writes nothing more. `reset --purge` removes the replica only under a live lease on the database it opened, so it never removes a replica another process took over or recreated. A node answer `410 RESET_REQUIRED` resets the replica in place and re-bootstraps from the same source; `status.lastReset` records it. A feed from a different node is `SOURCE_CHANGED` until `tc replica reset` clears the pin. A profile deleted before or while any `tc replica` command runs ends it with `REPLICA_NOT_FOUND`; nothing is written into the profile and it is never recreated.

## Read-through Replication Diagnostics

`--replication` enables the read-through adapter for one command;
`--no-replication` overrides `TC_REPLICATION=1`. It is off by default.
`--replication-debug` (or `TC_REPLICATION_DEBUG=1`) writes per-read, write
and sync details to stderr. The event log is
`profiles/<profile>/replication/events.jsonl` under `TC_HOME`; it records
operational metadata, not values.

`tc replica report [--since 24h]` renders read source/reason counts, hit ratio,
latency and staleness percentiles, sync/write outcomes, recent divergences,
replica/grant status, and pinned keys. `--json` emits the aggregate as JSON.
`--clear-pending` clears pending replica writes and prints a warning: commits
that arrive later can be observed as stale until a subsequent sync.
`auth logout` purges legacy and flag-owned replicas unless `--keep-replicas`
is used.

B-int release acceptance: test `tc auth request --grant` against a real
OpenKey test account without production writes. Approve the request, confirm
the grant is stored, start a fresh process, and verify saved prefixes are
replayed and the covered read is served locally. If explicit `kv/get` plus
`sync` is rejected, stop before release and resolve the protocol contract.

## Node Health

```bash
tc node health                  # Ping + latency
tc node version                 # Server version
tc node status                  # Combined
```

## Shell Completions

```bash
eval "$(tc completion bash)"
eval "$(tc completion zsh)"
tc completion fish | source
```

## Share Publish, Inspect, Receive, List, Revoke

Publishing needs the publishing scope on a dedicated profile (`tc --profile publisher auth login --device --manifest builtin:share-publishing`, or `tc --profile publisher enable share`). Publish with `tc --profile publisher share publish ...`.

```bash
tc share publish ./note.md --json                                  # bearer link
tc share publish ./note.md --to email:alice@example.com --notify   # addressed: exact email, emailed invitation (read required)
tc share publish ./note.md --to did:pkh:eip155:1:0xRecipient...    # addressed: one DID
tc share publish ./note.md --to domain:example.com                 # addressed: any verified address at the domain
tc share publish ./note.md --to domain:example.com --notify --notify-to alice@example.com  # invite one matching mailbox; node 1.17.3+
cat note.md | tc share publish - --name note.md

printf '%s' "$SHARE_URL" | tc share inspect - --json               # verify, print safe metadata
printf '%s' "$SHARE_URL" | tc share receive - --stdout             # bearer link: verified bytes
printf '%s' "$SHARE_URL" | tc share receive - --output .

tc share list --json                                               # sender history, no complete URLs
tc share show <id> [--reveal-link]
tc share notify <id> --to alice@example.com                        # retry email delivery within 5 minutes of publication
tc share revoke <id>
```

**Bearer vs addressed.** A bearer link (default, `--to anyone`) is `/viewer#tc1=<TinyCloud delegation>`: anyone holding the complete URL can read the file until it expires, and revocation cannot recall copies already received. Addressed links (`--to email:`, `--to did:`, `--to domain:`) are `/s/inline#v=2&p=<sealed Policy/v3 envelope>`: the content is encrypted and only the named recipient can open it after proving their email or DID in Share. `tc share receive` returns the bytes of a bearer link; for an addressed link it exits 6 with `CLAIM_REQUIRED` because the recipient claims it in Share. `--notify` requires the `read` action: exact-email targets invite the matched mailbox; domain targets need `--notify-to` naming one canonical mailbox at that exact domain and a node reporting version 1.17.3 or later. The CLI refuses unsupported domain invitations before uploading or registering a share. A session-only publisher can deliver its own domain policy when the invoking DID matches its signed owner DID; a different sender DID cannot. `tc share notify <id> --to <mailbox>` can address another mailbox in a domain share under the same node and sender-DID requirements; it refuses stored shares without `read` or on an unsupported node before sending.

The fragment after `#` is the read authority. It never reaches a server in a query string or HTTP request; keep complete URLs out of logs. Human publish output is exactly one URL. JSON publish output retains the redacted publication fields and adds `notification` (the `ShareNotifyResult`, including `state`, `attempts`, and optional failure `reason`) when `--notify` was requested. Inspect never prints plaintext or secret-bearing fields. Receive uses a sanitized single-segment filename and refuses overwrite unless `--force`. `revoke` revokes addressed shares at the owner node and reports bearer retention honestly. Pre-cutover blob-backed and plaintext `?tc2` links are not accepted.

**Notification window.** The CLI requests a stable signed delivery authorization until the earlier of share expiry and 5 minutes after its sender-history `registeredAt` timestamp. The node allows an authorization no more than 5 minutes in the future; keeping the expiry stable also makes idempotent retries use the same request. After the window, `tc share notify` prints `partial-failure` (exit 9; JSON `retryable: false`, `reason: "delivery-window-expired"`) and explains that the sender must publish a new share and invite the recipient then. `share publish --notify --json` includes the same failure under `notification`. A confirmed repeat within the window prints `already-delivered`; an unconfirmed failed attempt remains retryable until the window closes. If the sender history cannot record a successful delivery confirmation, the CLI warns on stderr but preserves the successful publish/notify result; a later repeat can report `delivered` again.

**History and node preflight.** Post-publication sender-history writes wait up to 45 seconds for another process's profile lock (including stale-lock recovery). If the first history write still fails, the CLI warns but prints the published link with its normal exit status; a later `share list`, `share notify <id>`, or `share revoke <id>` cannot find that share by ID. An immediate `--notify` can still deliver using the in-process record. Other share-command profile-lock timeouts report `PROFILE_LOCK_TIMEOUT` with a retry hint. Standalone domain notification validates the recipient and expired delivery window locally before contacting `/info`: an expired window remains exit 9 even if the node is unavailable. A node-info transport failure, including a stalled response body, is `UNAVAILABLE` (exit 4); a completed but unsupported or malformed version is `INVALID_ARGUMENT` (exit 2). Publish-time refusals say nothing was shared and no invitation was sent; standalone notify refusals say no invitation was sent.

**Concurrent history changes.** A Share command resolves its profile once for authentication and every sender-history operation, including retries; a later default-profile change cannot redirect a share link into another profile. If a write waits more than about 2 seconds to acquire the profile lock, the CLI writes one waiting notice to stderr naming that profile. A profile removed after an earlier history read or during an operation, or repeated key/salt changes, returns `SHARE_HISTORY_RETRY` (exit 1) with a retry hint; a profile missing from the outset still returns `PROFILE_NOT_FOUND` with the setup hint. If a history retry follows a revoke, check the node state before trying again: revocation might already have succeeded even though sender history could not record it.

Share publication without `--expires` requests a seven-day lifetime. For a session-only profile, the CLI clamps that request to the verified SIWE session expiry, prints a notice to stderr, and reports `"expiryClamped": true` in JSON. Explicit lifetimes beyond the session end, or with less than 60 seconds left after second-precision rounding, fail with `SESSION_LIFETIME_EXCEEDED`. Expired/invalid restored sessions and missing owner authority return `AUTH_REQUIRED`; rejected KV upload or delegation scopes return `PERMISSION_DENIED`. A session-only profile whose authority for an anyone-with-link share carries signed restrictions (caveats) is refused with `PERMISSION_DENIED` before anything is stored, because the link's delegation cannot carry the caveats; approve Share publishing without restrictions on a new profile (`tc init --name publisher --key-only && tc --profile publisher enable share`). Full TinyCloud storage returns the general storage-full error (`STORAGE_QUOTA_EXCEEDED` or `STORAGE_LIMIT_REACHED`, exit 10), and any other failed upload returns `UPLOAD_FAILED`; nothing is shared in either case. A filename that has characters other than `A-Z a-z 0-9 . _ -`, starts with anything but a letter or digit, contains `..`, or is longer than 128 characters is stored under a readable URI-safe name. It keeps its extension when that is 1-16 ASCII letters or digits (`Q3 plan (draft).md` is stored as `Q3-plan-draft.md`, `.env` as `share.env`); otherwise its dots become dashes, so it never gains one. Bearer links show the stored name and `receive` writes it, while addressed links keep the original. JSON publish output includes `expiryClamped: false` when no clamp was needed.

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
| Argument | `tc kv put key "value"` |
| File | `tc kv put key --file ./data.txt` |
| Stdin | `echo "data" \| tc kv put key --stdin` |

KV keys cannot contain spaces or control characters: the SDK sends keys unescaped in the node resource URI, so `get`, `put`, `head`, `delete` and `list --prefix` refuse them with `USAGE_ERROR` (exit 2) before authenticating. A `put` on full storage returns the general storage-full error (exit 10).

## Profile Directory Structure

```
~/.tinycloud/                      # 0700
├── config.json                    # Global config (defaultProfile)
├── profile-locks/
│   └── {name}/                    # Turn lock (see below); kept after `tc profile delete`
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

Every write to a profile (key, session, settings, delegations, permission requests) runs under the profile's lock, shared by `tc` and the MCP server. Processes of this release first take a turn in `profile-locks/{name}/`, then the `profiles/{name}/.lock` directory every release uses, so they keep excluding CLI 1.0.0-beta.16 and older (which hold `.lock` from its creation) and 1.0.0-beta.17 … 1.0.1-beta.4 (which hold it once `owner.json` is linked in), and those exclude them. Among processes of this release, mutual exclusion holds however long any of them is paused, and needs no hard links (FAT/exFAT and SMB mounts work).

That guarantee assumes every process using the profile runs on the same host and in the same PID namespace (a crashed process is recognised by its PID being gone), and a filesystem whose `rename` of a directory fails when the target exists. It does not hold for a `TC_HOME` shared across machines (NFS) or between containers that do not share a PID namespace: there a live process can look crashed, have its turn or staging directory removed, and the lock can be taken twice or stop working. Older releases running at the same time keep their own limits: a 1.0.0-beta.16-or-older process paused for longer than 30 s right after creating `.lock`, or a 1.0.0-beta.17 … 1.0.1-beta.4 process reclaiming `.lock` at the same moment as such a process, can still let two writers in. CLI 1.0.0-beta.16 and older never reclaim an abandoned `.lock` without an owner record; a newer release does, once it is 30 s old.

A crashed holder's lock is reclaimed automatically (`.lock` once 30 s old). With hard links, dead-owner recovery keeps a `.recover-*` claim inside `.lock` until it finishes; it never unlinks or moves a newly published live owner, and a failed claim never removes another writer's empty `.lock`. A crashed current-release recoverer may leave only a `.recover-*` claim. Releases through 1.0.1-beta.4 cannot reclaim it even after it ages. A current-release command that acquires the affected profile's lock processes the claim, restoring a live owner's record if it contains one.

On either recovery path, an orphaned `.recover-*` claim can hold a replacement owner's live record: the hard-link path may claim it before detecting a mismatch, and the no-hard-links path may move it before putting it back. If the recoverer crashes and that holder releases while its process stays alive, the next acquisition restores the claimed record as `owner.json`. Acquisition can then remain blocked until the PID exits **and** the record is at least 30 s old—for a long-lived MCP server, possibly until it restarts. This costs availability only; it never admits a second holder. To clear the stalled profile manually, remove its `profiles/{name}/.lock` **only when no `tc` or MCP process is running**.

`PROFILE_LOCK_TIMEOUT` naming `profile-locks/{name}` means its turn lock is damaged (for example by a disk error): when no `tc` or MCP process is using that profile, remove `~/.tinycloud/profile-locks/{name}`; it is recreated on the next write. A write that waited for the lock while `tc profile delete` removed the profile fails with `PROFILE_NOT_FOUND` instead of recreating it.

## DID Formats

- **Session key**: `did:key:z6Mk...#z6Mk...` — generated at init
- **Owner DID**: `did:pkh:eip155:{chainId}:{address}` — after auth

Use `--json` for machine-readable output; interactive commands can render human output. General command errors go to stderr as `{error: {code, message, hint?, meta?}}`. `meta` contains a typed HTTP `status` and, only when validated as a TinyCloud capability (and against the KV request when available), a `resource` and `requiredAction`. Inspect the structured code, not only the exit status.

General storage/auth exit codes: 0 success, 1 operation error, 2 invalid input, 3 authentication required, 4 not found, 5 permission denied, 6 network error, 7 node error, 10 storage full. `tc share` uses its own: 1 profile lock timeout or sender-history retry (`PROFILE_LOCK_TIMEOUT`, `SHARE_HISTORY_RETRY`), 3 upload authority required, 4 unavailable, expired or upload failed, 5 permission denied (`PERMISSION_DENIED`) or verification failed, 6 recipient authorization required or network error, 7 byte limit, 8 output conflict or unsafe filename, 9 partial success, 10 storage full.

For `tc kv get|put|head|list|delete`, `tc space list|host`, `tc sql`, `tc vault`, `tc vars`, `tc duckdb`, `tc secrets list|put|delete`, `tc delegation`, and `tc account`, service-result errors use typed authorization: a plain HTTP 401 is `AUTH_REQUIRED` (exit 3); a 403 is `PERMISSION_DENIED` (exit 5). A 401 with a validated missing capability, or `AUTH_UNAUTHORIZED` without an HTTP status, is `PERMISSION_DENIED` (exit 5); a validated capability also produces a `tc auth request --cap` hint. This changes the former exit 1 for status-less `AUTH_UNAUTHORIZED` in the listed commands. Other HTTP failures retain their service-specific codes. `tc share` has separate exit mappings below.

Every command that writes reports full TinyCloud storage the same way: `STORAGE_QUOTA_EXCEEDED` (storage is full) or `STORAGE_LIMIT_REACHED` (this write is larger than what is left), exit 10, with nothing written (`tc sql copy` instead names the table and the rows it had already copied). The hint gives the account totals when the node reports them (`371.7 MiB used of 100 MiB (free plan)`), says reading still works, and links to https://account.tinycloud.xyz/billing. Retrying cannot succeed until the owner frees up space or upgrades.
