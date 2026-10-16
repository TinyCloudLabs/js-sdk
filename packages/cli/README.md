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
Use `tc replica report` for event aggregates and pinned keys; `--clear-pending`
prints a warning because later commits can be read as stale until a subsequent
sync. `auth logout` removes both legacy replicas and the flag-owned
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

### Private diagnostic history

`tc diagnostics` (also `tinycloud diagnostics`) is local-only and does not load a
profile, authentication, or the business SDK. Capture is **off by default** and
is separate from `doctor`, service logs, replication, and personal application data.

```bash
tc diagnostics status --json
tc diagnostics enable --scope tc-apps
tc diagnostics pause
tc diagnostics resume
tc diagnostics disable
```

Enablement does not make unrelated CLI work eligible for capture. Validated
personal-app KV targets and the exact personal-app SQL copy database establish
scope after parsing. To include startup/parser failures, scope only a selected
command or shell block:

```bash
tc diagnostics run --scope tc-apps -- sh ./selected-app-block.sh
```

Never scope a whole coding client or shared long-lived server. Without `--scope`,
`diagnostics run -- <executable> <args...>` creates run attribution only and
removes inherited activity scope. It inherits stdin/stdout/stderr directly,
preserves child exit/signal results, and records no command line or terminal
content. Ordinary KV/SQL commands require no launcher or context.

`diagnostics status` reports scope, retention, current storage usage, available
native-source provenance and baseline adapter support without reading profiles
or inspecting client installations. Controlled exports and selected detail count
toward partition usage; the partition limit includes detail. Selected content is
not printed by status.
The partition cap is 100 MiB, including a 10 MiB selected-detail cap; the root-wide
cap is 1 GiB. These bounds include managed imports, cases and exports, not just
active metadata segments. Keep the root on private encrypted storage and exclude
selected detail from backups. Filesystem permissions alone do not encrypt it.

Private review and transfer use exact JSON selections containing generated
`source_ids`, `event_ids`, `invocation_ids`, or explicit `from`/`until` bounds:

Review keeps business outcome, canonical status, mutation certainty, verification,
copy state, protocol result, transport send settlement, and observed HTTP delivery
separate. A successful send is not client receipt. An initial `not_dispatched`
marker alone does not prove that a mutation never ran; an unknown attempt remains
unknown after a later recovery. Missing task linkage and provenance stay explicit.
Phase and wrapper-attempt parents are resolved only through source-qualified
explicit IDs; ambiguous links remain unknown. Comparisons require both invocation
start and finish evidence rather than treating a finish-only selection as full
coverage.

```bash
tc diagnostics review --selection selection.json --json
tc diagnostics export --selection selection.json --out /private/diagnostics/exports/11111111-1111-4111-8111-111111111111 --expires-at 2026-10-20T00:00:00.000Z
tc diagnostics import /private/received-bundle
tc diagnostics compare --left left-selection.json --right right-selection.json
tc diagnostics delete --selection selection.json
tc diagnostics delete --selection selection.json --confirm --pause-after
```

The managed export destination must use a fresh generated UUID beneath the configured
root's `exports` subtree. Transfer the portable directory returned in the command's
`path` field, not its parent containing local management metadata.
`--external` explicitly permits a destination outside the entire diagnostic root
and reports that recipient copies are outside automatic quota, expiry and
deletion enforcement. Delete defaults to preview; `--confirm` authorizes only
the exact file selection. A selection with `"all": true` additionally requires
`--pause-after` or `--keep-enabled`.

Selected passages are a separate, explicit detail tier. First acknowledge the
encrypted-disk and backup policy with
`diagnostics enable --scope tc-apps --detail-policy encrypted-excluded-backups`.
`diagnostics select --manifest selected-case.json` accepts only the bounded
owner-selected manifest, never a transcript directory. Review detail only with
`case_ids` and `include_detail: true`. Use
`diagnostics bundle --case <id> --fixture synthetic-fixture.json --out <directory> --expires-at <UTC>`
to assemble reviewed synthetic reproduction evidence; it does not execute it.

History is best effort: bounded queues and a 300 ms synchronous terminal-wait
budget can lose evidence; scheduling and teardown add overhead. Missing
completion remains unknown. Scoped policy discovery uses a read-only helper,
including when capture is disabled; unrelated commands start no diagnostic
helper. Diagnostic filesystem work stays outside the business process.
Retention is 30 days for metadata and 7 days for selected detail. Quota exhaustion
drops diagnostic writes rather than blocking business work. Disable does not
delete history or change business records/grants. Coverage includes CLI startup
and termination, approval wait/verification/commit, grant replay, KV/SQL physical
attempts, record/read/copy phases, and hosted protocol/delivery outcomes. Wrapper,
transport and copy retries remain separate. A paste handoff is `awaiting_owner`,
not a completed login; a lost mutation acknowledgment remains unknown even if
a later attempt succeeds. Metadata alone cannot verify the intended date, units,
record values, final client answer, or receipt of a response.
Health recovery retains at most 64 attribution buckets per producer/helper;
terminal failure or overflow may leave loss unknown rather than a durable count.
Native signal death retains the process's original signal behavior and may leave
no finish event. Existing auth and replication signal handlers observe only
their own boundaries; diagnostics installs no replacement signal handler.

Client launch is attribution only, not automatic capture or proof of a client
version. Claude Code and Codex use baseline capture plus explicit selected-block
launch/manual selection; automatic hooks are unsupported. The optional OpenCode
v1 adapter has a pinned 1.18.31 source/loopback contract, not installed-client
acceptance; OpenCode v2 uses the same baseline/manual fallback. No adapter
permission or installation is implied by installing this package.

Before using a released package, verify its exact version and worker assets in a
disposable home, then obtain separate metadata enablement and adapter-installation
authorization. Package installation must leave capture off. Disabling capture
does not delete managed history; use an explicit selection and inspect deletion
results. Offline machines enforce cleanup on next use, not while powered off.
Backups and external recipient copies have separate deletion boundaries. Rollback
starts by disabling capture/adapter emission, not removing profiles or revoking
record access; retained history still needs expiry or an explicit delete decision.


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
| `TC_DIAGNOSTICS_HOME` | Explicit private diagnostic root; defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/tinycloud/diagnostics`. Never a profile or replication directory. |
| `TC_DIAGNOSTICS_CONTEXT` | Bounded versioned opaque attribution and selected-block scope; does not enable capture or select diagnostic storage. |

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
