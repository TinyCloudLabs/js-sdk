# TC CLI Command Reference

<!-- BEGIN GENERATED TINYCloud operations coverage -->
This release has **Commander coverage tracked, not complete parity**:

- 1 migrated registration(s).
- 1 partially migrated registration(s).
- 115 legacy registration(s) remain Commander-owned.

- `auth import [source]` → `tinycloud.auth.import@1` (partial; legacy inputs: v1 delegation artifact, v1 permission artifact without command, bare portable delegation, stored delegation wrapper, cross-user delegation persisted with activated=false).
- `secrets get <name>` → `tinycloud.secrets.get@1` (migrated).
<!-- END GENERATED TINYCloud operations coverage -->

## Selected context and scoped authentication

`tc --profile PROFILE --host HOST context --space SPACE` always emits JSON for the selected context. It reports local session state, not proven access. Use actual storage reads to verify authority.

`tc auth login --method openkey --manifest FILE --expiry 7d [--owner PRIMARY_DID]` requests one manifest space on first login. `--paste` supports manual terminal return; `--no-popup` prints the browser URL. Read [AUTH.md](AUTH.md) before same-account setup.

## Global Options

| Flag | Description |
|------|-------------|
| `-p, --profile <name>` | Profile to use |
| `-H, --host <url>` | Node URL override |
| `-v, --verbose` | Verbose output |
| `-q, --quiet` | Suppress non-essential output |
| `--no-cache` | Disable caching |
| `--json` | Force machine-readable output |

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

## Share Publish, Inspect, and Receive

```bash
tc share publish ./decision.md
cat decision.md | tc share publish - --name decision.md --expires 7d
printf '%s' "$SHARE_URL" | tc share inspect - --json
printf '%s' "$SHARE_URL" | tc share receive - --output .
printf '%s' "$SHARE_URL" | tc share receive - --stdout
```

Human publish output is exactly one canonical URL. Inspect never prints
plaintext or secret-bearing fields. Receive verifies the link before writing,
uses a sanitized single-segment filename, and refuses overwrite unless
`--force` is explicit. Modern commands accept compact-v1 and inline-v2 links;
legacy `tc1:` links are not accepted by these commands.

### Share Publish Options

| Flag | Description | Default |
|------|-------------|---------|
| `file` | Markdown file or `-` for bounded stdin | required |
| `--name <filename>` | Safe filename for stdin | `stdin.md` |
| `--to <target>` | Bearer target (`anyone`) | `anyone` |
| `--expires <duration>` | Duration: `1h`, `7d`, `1w`, or ISO date | `7d` |
| `--inline` | Use the explicit inline-v2 link | off |
| `--json` | Emit versioned redacted JSON | off |

## KV Put Input Sources (mutually exclusive)

| Source | Example |
|--------|---------|
| Argument | `tc kv put key "value"` |
| File | `tc kv put key --file ./data.txt` |
| Stdin | `echo "data" \| tc kv put key --stdin` |

## Profile Directory Structure

```
~/.tinycloud/
├── config.json                    # Global config (defaultProfile)
└── profiles/
    └── {name}/
        ├── profile.json           # Host, DID, chainId
        ├── key.json               # Ed25519 JWK keypair
        ├── session.json           # Delegation, spaceId
        └── cache/
```

## DID Formats

- **Session key**: `did:key:z6Mk...#z6Mk...` — generated at init
- **Owner DID**: `did:pkh:eip155:{chainId}:{address}` — after auth

Use `--json` for machine-readable output; interactive commands can render human output. General command errors go to stderr as `{error: {code, message, hint?}}`. Inspect the structured code, not only the exit status.

General storage/auth exit codes are 0 success, 1 operation error, 2 invalid input, 3 authentication required, 4 not found, 5 permission denied, 6 network error, and 7 node error. The Share commands use their own exit-code meanings (see `tc share --help`); do not apply those meanings to KV/SQL errors.
