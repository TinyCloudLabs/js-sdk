# @tinycloud/cli

Self-sovereign storage from the terminal. `tc` is the command-line interface for [TinyCloud](https://tinycloud.xyz) — manage data, delegations, spaces, and nodes without leaving your shell.

## Install

```bash
npm install -g @tinycloud/cli
```

Requires Node.js >= 20.

The package installs two identical commands: `tc` and `tinycloud`. On Linux,
iproute2 installs `/usr/sbin/tc` (traffic control), which can shadow `tc` on
PATH; `tinycloud` avoids that clash and accepts the same arguments. If the npm global prefix is root-owned, run
`npm config set prefix ~/.local` before installing: Ubuntu's default PATH puts
`~/.local/bin` before `/usr/sbin`, but `~/.profile` adds it only if the
directory existed at login, so start a new login shell after the first
install. Run `hash -r` if `tc` already ran in the same shell. Verify with
`command -v tc`, or call `"$(npm prefix --global)/bin/tc"` when in doubt.

## Agent skills

The package ships the general `tc-cli` skill and its references in
`skills/tc-cli`, and the `courier` skill for `tc courier` in `skills/courier`.
See [skill installation](skills/tc-cli/INSTALL.md) for a
pinned, cross-agent installation with OpenCode, Codex and Claude Code, and
[authentication](skills/tc-cli/AUTH.md) for device login and relaying the
approval code to the owner.

## Courier

`tc courier …` runs [Courier](https://github.com/TinyCloudLabs/js-sdk/tree/master/packages/courier#readme), agent-to-agent threads
over TinyCloud, bundled from `@tinycloud/courier` (beta). It takes the same
arguments as the standalone `courier` bin and keeps its own agent identity in
`$COURIER_HOME` (default `~/.courier`), not in a tc profile, so put every flag
after `courier`:

```bash
tc courier init --paste --handle alice   # the owner approves in OpenKey; paste the XXXX-XXXX code
tc courier inbox
tc courier --help
```

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

# Authenticate on a remote/headless machine: the owner approves an explicit
# manifest on their phone (URL + code printed to stderr). Use a new profile
# name if it already exists; keep the user's existing profiles.
tc init --name publisher --key-only
tc --profile publisher auth login --device --manifest builtin:share-publishing

# Same Share publishing scope, as a shortcut (on the dedicated profile)
tc --profile publisher enable share

# Selected profile, owner, host and space (JSON; does not test access)
tc context

# Store and retrieve data
tc kv put greeting "Hello, world"
tc kv get greeting
tc kv list

# Manage network-encrypted secrets on the default network
tc secrets network init
printf '%s' "$ANTHROPIC_API_KEY" | tc secrets put ANTHROPIC_API_KEY --stdin
tc secrets get ANTHROPIC_API_KEY

# Ask the owner for a secret an agent needs, then wait for it
# (call TinyCloud's CLI by absolute path: a bare `tc` can be iproute2's /usr/sbin/tc)
TC_BIN="$(npm prefix --global)/bin/tc"
"$TC_BIN" --profile agent secrets request OPENAI_API_KEY --json   # offline; prints the owner's link
"$TC_BIN" --profile agent secrets wait OPENAI_API_KEY --timeout 9m --json   # 0 ready, 8 pending

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
| `tc auth login --device --manifest <file>` | Approve exactly a manifest's permissions on another device (phone) |
| `tc auth login --manifest <file>` | Browser OpenKey login scoped to a manifest |
| `tc enable share` | Device login with the built-in Share publishing manifest (use a dedicated profile) |
| `tc context` | Show the selected profile, owner, host, space and session state |
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
| `tc secrets request` | Print a Secret Manager link asking the owner to add secrets (offline) |
| `tc secrets wait` | Wait until secrets exist and are readable (never signs in; needs a stored session; exit 8 pending, 130 interrupted) |
| `tc secrets manage` | Print or open the Secret Manager page, `{url, opened}` |
| `tc vars` | Manage environment variables |
| `tc doctor` | Run diagnostic checks |
| `tc completion` | Generate shell completions |
| `tc courier` | Agent-to-agent threads over TinyCloud (beta; see [Courier](#courier)) |

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
    --replication       Enable read-through replication (or TC_REPLICATION=1)
    --no-replication    Disable replication for this invocation
    --replication-debug Write replication diagnostics to stderr
```

Replication is off by default. `--replication` enables it for one invocation;
`--no-replication` overrides `TC_REPLICATION=1`, and `--replication-debug`
writes diagnostics to stderr. Save explicit login prefixes with
`tc auth login --replication-prefix notes/`; saved prefixes are reapplied on
later logins and rotation. Prefixes are folders (`notes/`) or `/` for the
whole space. Whole-space replication requires `kv-sync-root` support and
`--replication-allow-secrets`, because it includes `vault/`. Replication needs
unrestricted `get` and explicit `sync` on that folder or broader; an exact-key
grant never qualifies. Bare replica prefixes are rejected; use `notes/`.
Use `tc replica report` for read-only aggregates of persisted replication events
and identity partitions. Live replica status is unavailable there. Report
`--purge` and `--clear-pending` refuse with exit 2 `REPORT_READ_ONLY`.
`tc replica reset --replica <name> --purge` is a partial alternative for a
named local replica only.
Flag-owned purge and pending clearing have no equivalent yet (TC-1309).
On macOS and Windows, `replica reset --purge` and `auth logout` with a legacy
`replicas/` tree refuse local removal rather than delete through an unpinned
path; leave that tree intact and retry on a supported platform.
`auth logout` removes both legacy replicas and the flag-owned
`replication/` root; `auth logout --keep-replicas` keeps both. B-int release
acceptance must verify the OpenKey `tc auth request --grant` fallback against
a real OpenKey using a test account and no production writes: approve the
request, confirm the grant is stored, start a fresh process, and verify the
saved prefixes are replayed and the covered read is served locally. If OpenKey
rejects explicit `kv/get` plus `sync`, stop before release and resolve the
protocol contract.

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
| `TC_REPLICATION` | Set to `1` to enable replication by default; `--no-replication` overrides it. |
| `TC_REPLICATION_DEBUG` | Set to `1` to enable replication diagnostics on stderr. |

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
