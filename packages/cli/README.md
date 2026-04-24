# @tinycloud/cli

Self-sovereign storage from the terminal. `tc` is the command-line interface for [TinyCloud](https://tinycloud.xyz) — manage data, delegations, spaces, and nodes without leaving your shell.

## Install

```bash
npm install -g @tinycloud/cli
```

Requires Node.js >= 18.

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
| `tc vault` | Manage encrypted vaults |
| `tc secrets` | Manage secrets |
| `tc vars` | Manage environment variables |
| `tc doctor` | Run diagnostic checks |
| `tc completion` | Generate shell completions |

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

## Environment

| Variable | Description |
|----------|-------------|
| `TC_HIDE_BANNER` | Set to `1` to suppress the startup banner |

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
