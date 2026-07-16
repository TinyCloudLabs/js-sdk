# @tinycloud/cli

Self-sovereign storage from the terminal. `tc` is the command-line interface for [TinyCloud](https://tinycloud.xyz) — manage data, delegations, spaces, and nodes without leaving your shell.

## Install

```bash
npm install -g @tinycloud/cli
```

Requires Node.js >= 20.

## Operations coverage

The migrated `tc secrets get` path is owned by `@tinycloud/operations` and
uses delegated authority by default. `tc auth import` is partially migrated:
the request-bound active-session v1 path is canonical, while legacy delegation
and permission input forms remain Commander-owned. The complete registration
ledger is checked in `../operations/coverage.json` and checked against the
actual Commander tree in CI.

Secret values are never included in permission requests, errors, logs, or
persisted request/delegation metadata. The terminal may display a successful
value when explicitly requested; MCP hosts control their own transcript
retention. Owner authority is an explicit posture choice, not an automatic
fallback for delegated execution.

## Quick Start

```bash
# Set up a profile and generate keys
tc init

# Authenticate via browser
tc auth login

# Store and retrieve data
tc kv put greeting "Hello, world"
tc kv get greeting
tc kv list

# Manage network-encrypted secrets on the default network
tc secrets network init
tc secrets put ANTHROPIC_API_KEY "sk-..."
tc secrets get ANTHROPIC_API_KEY

# Manage spaces
tc space list
tc space create

# Grant access to another user
tc delegation create --to did:pkh:eip155:1:0x...
```

## Commands

| Command | Description |
|---------|-------------|
| `tc init` | Set up a profile and generate keys |
| `tc auth login` | Authenticate via browser |
| `tc auth status` | Show authentication status |
| `tc auth whoami` | Show current identity |
| `tc kv get <key>` | Retrieve a value |
| `tc kv put <key> <value>` | Store a value |
| `tc kv list` | List all keys |
| `tc sql query <sql>` | Run a SQLite SELECT query |
| `tc sql execute <sql>` | Run a SQLite write or schema statement |
| `tc sql export` | Export a SQLite database file |
| `tc space list` | List your spaces |
| `tc space create` | Create a new space |
| `tc delegation create` | Grant access to another user |
| `tc delegation list` | List delegations |
| `tc share` | Share data with another user |
| `tc node` | Manage TinyCloud nodes |
| `tc profile list` | List profiles |
| `tc profile show` | Show profile details |
| `tc profile create` | Create a new profile |
| `tc vault` | Manage encrypted KV vaults |
| `tc secrets` | Manage network-encrypted secrets |
| `tc secrets network show` | Show a secrets decryption network |
| `tc secrets network init` | Create or fetch the default secrets network |
| `tc secrets network grant` | Grant `tinycloud.encryption/decrypt` on a secrets network |
| `tc vars` | Manage environment variables |
| `tc doctor` | Run diagnostic checks |
| `tc completion` | Generate shell completions |

Secret names are env-style uppercase identifiers such as `FIREFLIES_API_KEY`.
`tc secrets network show` accepts either a short network name or a full
`urn:tinycloud:encryption:<ownerDid>:<network>` identifier. `tc secrets
network grant` takes the short name, resolves the network, and grants
`tinycloud.encryption/decrypt`.

## Global Options

```
-p, --profile <name>    Profile to use
-H, --host <url>        TinyCloud node URL
-v, --verbose           Enable verbose output
-q, --quiet             Suppress non-essential output
    --json              Force JSON output
    --no-cache          Disable caching
```

## Output Modes

`tc` auto-detects your terminal:

- **Interactive (TTY)** — human-friendly output with colors, tables, and status icons
- **Piped / redirected** — structured JSON for scripting
- **`--json` flag** — force JSON output in any context

```bash
# Human-friendly table
tc kv list

# JSON for scripting
tc kv list --json
tc kv list | jq '.[]'
```

## Diagnostics

```bash
tc doctor
```

Checks Node.js version, profile configuration, keys, session status, node connectivity (with latency), and space availability. Outputs actionable guidance for any failing checks.

## Profiles

`tc` supports multiple profiles for different environments:

```bash
tc profile create staging --host https://staging.tinycloud.xyz
tc profile list
tc kv list --profile staging
```

### Pointing a profile at a self-hosted OpenKey

OpenKey-backed profiles default to `https://openkey.so`. To use a self-hosted
or local OpenKey (for testing accounts, CI, or a portless dev loop), edit the
profile JSON directly:

```bash
# ~/.tinycloud/profiles/<profile>/profile.json
{
  "name": "staging",
  ...
  "openkeyHost": "https://openkey.localhost"
}
```

`tc auth login --method openkey` and `tc auth request` honor this for the
profile. Set `TC_OPENKEY_HOST` to override per invocation without editing the
file.

## Environment

| Variable | Description |
|----------|-------------|
| `TC_HIDE_BANNER` | Set to `1` to suppress the startup banner |
| `TC_OPENKEY_HOST` | Override the active profile's OpenKey base URL for this invocation. |

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Watch mode
bun run dev
```

## License

EGPL
