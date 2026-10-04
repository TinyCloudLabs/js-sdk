# TC CLI Command Reference

<!-- BEGIN GENERATED TINYCloud operations coverage -->
This release has **Commander coverage tracked, not complete parity**:

- 1 migrated registration(s).
- 1 partially migrated registration(s).
- 116 legacy registration(s) remain Commander-owned.

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
| `--owner <did>` | Refuse approval by any identity other than this `did:pkh`; must agree with an owner the profile already recorded. Also names the secrets owner for a manifest's `secrets` when the profile has no recorded owner |
| `--replace-session` | Scoped or device login: replace a live session the new scope would narrow, change or shorten (otherwise `SESSION_IN_USE`); renewals and widenings that last at least as long need no flag |
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

When neither stdin nor stderr is a terminal, `secrets get|list|put|delete` on an OpenKey profile that lacks the grant fails with `PERMISSION_DENIED` (exit 5) and a scoped paste-login hint. Missing or expired sessions instead fail with `AUTH_REQUIRED` (exit 3) before a canonical read invokes the node or starts an unscoped browser refresh. Redirected stdout alone does not disable an owner's browser approval; its URL appears on stderr and terminal stdin accepts a code. `secrets get -o` validates the destination and existing directory before any read or decrypt, then syncs a fresh 0600 inode and atomically replaces an existing regular file. Directory sync is best-effort after replacement and cannot turn a completed write into a reported failure. It refuses symlinks, directories, devices and absent parent directories (`INVALID_ARGUMENT`); an unreplaceable filesystem target fails with a sanitized error naming the destination, without a non-atomic fallback. A node that refuses decrypt (HTTP 401/403) is reported as missing authority on the invoked network, not as an undecryptable secret.

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

**Concurrent history changes.** Each history operation pins its starting profile across salt and key-input retries; a later default-profile change cannot redirect a share link into another profile. If a write waits more than about 2 seconds to acquire the profile lock, the CLI writes one waiting notice to stderr naming that profile. A profile removed mid-operation or repeated key/salt changes return `SHARE_HISTORY_RETRY` (exit 1) with a retry hint rather than `INVALID_ARGUMENT`. If this follows a revoke, check the node state before trying again: node revocation might already have succeeded even though sender history could not record it.

Share publication without `--expires` requests a seven-day lifetime. For a session-only profile, the CLI clamps that request to the verified SIWE session expiry, prints a notice to stderr, and reports `"expiryClamped": true` in JSON. Explicit lifetimes beyond the session end, or with less than 60 seconds left after second-precision rounding, fail with `SESSION_LIFETIME_EXCEEDED`. Expired/invalid restored sessions and missing owner authority return `AUTH_REQUIRED`; rejected KV upload or delegation scopes return `PERMISSION_DENIED`. A session-only profile whose authority for an anyone-with-link share carries signed restrictions (caveats) is refused with `PERMISSION_DENIED` before anything is stored, because the link's delegation cannot carry the caveats; approve Share publishing without restrictions on a new profile (`tc init --name publisher --key-only && tc --profile publisher enable share`). A full storage quota returns `STORAGE_QUOTA_EXCEEDED`, with the used and limit sizes when the node reports them, and any other failed upload returns `UPLOAD_FAILED`; nothing is shared in either case. A filename that has characters other than `A-Z a-z 0-9 . _ -`, starts with anything but a letter or digit, contains `..`, or is longer than 128 characters is stored under a readable URI-safe name. It keeps its extension when that is 1-16 ASCII letters or digits (`Q3 plan (draft).md` is stored as `Q3-plan-draft.md`, `.env` as `share.env`); otherwise its dots become dashes, so it never gains one. Bearer links show the stored name and `receive` writes it, while addressed links keep the original. JSON publish output includes `expiryClamped: false` when no clamp was needed.

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

KV keys cannot contain spaces or control characters: the SDK sends keys unescaped in the node resource URI, so `get`, `put`, `head`, `delete` and `list --prefix` refuse them with `USAGE_ERROR` (exit 2) before authenticating. A full storage quota on `put` returns `STORAGE_QUOTA_EXCEEDED` (exit 1).

## Profile Directory Structure

```
~/.tinycloud/                      # 0700
├── config.json                    # Global config (defaultProfile)
└── profiles/
    └── {name}/                    # 0700
        ├── profile.json           # Host, DID, chainId, ownerDid, spaceId (0600)
        ├── key.json               # Ed25519 JWK keypair (0600)
        ├── session.json           # Delegation, spaceId (0600)
        └── cache/
```

## DID Formats

- **Session key**: `did:key:z6Mk...#z6Mk...` — generated at init
- **Owner DID**: `did:pkh:eip155:{chainId}:{address}` — after auth

Use `--json` for machine-readable output; interactive commands can render human output. General command errors go to stderr as `{error: {code, message, hint?}}`. Inspect the structured code, not only the exit status.

General storage/auth exit codes: 0 success, 1 operation error, 2 invalid input, 3 authentication required, 4 not found, 5 permission denied, 6 network error, 7 node error. `tc share` uses its own: 3 upload authority required, 4 unavailable, expired, storage quota exceeded or upload failed, 5 permission denied (`PERMISSION_DENIED`) or verification failed, 6 recipient authorization required or network error, 7 byte limit, 8 output conflict or unsafe filename, 9 partial success.
