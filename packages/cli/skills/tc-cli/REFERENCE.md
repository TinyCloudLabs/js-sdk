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
tc init --name agent --key-only
tc --profile agent auth login --device --manifest builtin:share-publishing --expiry 7d
tc --profile agent context --json
```

`context` always emits JSON: profile, `ownerDid`, `sessionDid`, host, `spaceId` and local session expiry, with `access: "not-tested"`. It never prints keys or signed material.

| `auth login` flag | Description |
|------|-------------|
| `--device` | Approve on another device (phone) through OpenKey device authorization. Requires `--manifest`. Prints `Approve on your phone: URL (code XXXX-XXXX)` to stderr and waits for the whole approval window |
| `--manifest <file>` | Request only this manifest's permissions (one space). File path, `base64:<json>`, or `builtin:share-publishing` |
| `--expiry <duration>` | Session lifetime, e.g. `1h`, `7d`. Device login: at most `30d`, default `30d` |
| `--owner <did>` | Refuse approval by any identity other than this `did:pkh` |
| `--method openkey\|local` | Browser OpenKey flow or local Ethereum key |
| `--paste`, `--no-popup` | Browser flow without a local callback / without opening a browser |

Device login JSON lists approved `permissions`, owner-unchecked `declined` capabilities, `ownerDid`, `spaceId` and `expiresAt`. `tc auth request --manifest FILE --grant --device` adds another space to a logged-in profile the same way. `tc enable share` is shorthand for device login with `builtin:share-publishing`. Errors: `MANIFEST_REQUIRED`, `SCOPE_REJECTED` (OpenKey refused a capability; the message names it), `DEVICE_AUTH_DENIED`, `DEVICE_AUTH_EXPIRED`, `OPENKEY_OWNER_MISMATCH`, `OPENKEY_GRANT_BROADENED`. See [AUTH.md](AUTH.md).

`builtin:share-publishing` requests, in the owner's `default` space, KV `get`/`put`/`list`/`del` on `xyz.tinycloud.share/shares/` (bearer links) and KV `get`/`metadata`/`put`/`list`/`del` on `shares/` (addressed links). Nothing else.

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
tc secrets list
tc secrets delete ANTHROPIC_API_KEY
```

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

Publishing needs the publishing scope on the profile (`auth login --device --manifest builtin:share-publishing` or `tc enable share`).

```bash
tc share publish ./note.md --json                                  # bearer link
tc share publish ./note.md --to email:alice@example.com --notify   # addressed: exact email, emailed invitation
tc share publish ./note.md --to did:pkh:eip155:1:0xRecipient...    # addressed: one DID
tc share publish ./note.md --to domain:example.com                 # addressed: any verified address at the domain
cat note.md | tc share publish - --name note.md --expires 7d

printf '%s' "$SHARE_URL" | tc share inspect - --json               # verify, print safe metadata
printf '%s' "$SHARE_URL" | tc share receive - --stdout             # bearer link: verified bytes
printf '%s' "$SHARE_URL" | tc share receive - --output .

tc share list --json                                               # sender history, no complete URLs
tc share show <id> [--reveal-link]
tc share notify <id> --to alice@example.com                        # retry email delivery
tc share revoke <id>
```

**Bearer vs addressed.** A bearer link (default, `--to anyone`) is `/viewer#tc1=<TinyCloud delegation>`: anyone holding the complete URL can read the file until it expires, and revocation cannot recall copies already received. Addressed links (`--to email:`, `--to did:`, `--to domain:`) are `/s/inline#v=2&p=<sealed Policy/v3 envelope>`: the content is encrypted and only the named recipient can open it after proving their email or DID in Share. `tc share receive` returns the bytes of a bearer link; for an addressed link it exits 6 with `CLAIM_REQUIRED` because the recipient claims it in Share. `--notify` emails an exact-email recipient an invitation.

The fragment after `#` is the read authority. It never reaches a server in a query string or HTTP request; keep complete URLs out of logs. Human publish output is exactly one URL. Inspect never prints plaintext or secret-bearing fields. Receive uses a sanitized single-segment filename and refuses overwrite unless `--force`. `revoke` revokes addressed shares at the owner node and reports bearer retention honestly. Pre-cutover blob-backed and plaintext `?tc2` links are not accepted.

### Share Publish Options

| Flag | Description | Default |
|------|-------------|---------|
| `files` | One or more files, or `-` for bounded stdin | required |
| `--name <filename>` | Safe filename for stdin | `stdin.md` |
| `--to <target>` | `anyone`, recipient DID, email, or `domain:<name>` | `anyone` |
| `--notify` | Send the addressed link through the email-only API | off |
| `--expires <duration>` | Duration: `1h`, `7d`, `1w`, or ISO date | `7d` |
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

General storage/auth exit codes: 0 success, 1 operation error, 2 invalid input, 3 authentication required, 4 not found, 5 permission denied, 6 network error, 7 node error. `tc share` uses its own: 3 upload authority required, 4 unavailable or expired, 5 verification failed, 6 recipient authorization required or network error, 7 byte limit, 8 output conflict or unsafe filename, 9 partial success.
