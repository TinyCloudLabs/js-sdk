# @tinycloud/cli

Self-sovereign storage from the terminal. `tinycloud` is the command-line interface for [TinyCloud](https://tinycloud.xyz) — manage data, delegations, spaces, and nodes without leaving your shell.

## Install

```bash
npm install -g @tinycloud/cli@1.5.0-beta.20
```

Requires Node.js >= 20; TinyCloud's agent guides use Node.js 22.20 or later.
Agents: start at https://agents.tinycloud.xyz/onboarding.

The package exposes `tinycloud` as its preferred command and keeps `tc` as a
deprecated compatibility alias at the same entry. Both names accept the same
commands and flags, with identical exit codes and stdout. A POSIX `tc` executable
link emits one deprecation notice on stderr, never stdout. On Linux,
`/usr/sbin/tc` is iproute2's traffic-control tool. Verify the pinned install
with `tinycloud --version`.

## Agent skills

The package ships the general `tinycloud-cli` skill and its references in
`skills/tinycloud-cli`, and the `courier` skill for `tinycloud courier` in `skills/courier`.
See [skill installation](skills/tinycloud-cli/INSTALL.md) for a
pinned, cross-agent installation for any agent, and
[authentication](skills/tinycloud-cli/AUTH.md) for device login and relaying the
approval code to the owner.

## Courier

`tinycloud courier …` runs [Courier](https://github.com/TinyCloudLabs/js-sdk/tree/master/packages/courier#readme), agent-to-agent threads
over TinyCloud, bundled from `@tinycloud/courier` (beta). It takes the same
arguments as the standalone `courier` bin and keeps its own agent identity in
`$COURIER_HOME` (default `~/.courier`), not in a tinycloud profile, so put every flag
after `courier`:

```bash
tinycloud courier init --paste --handle alice   # the owner approves in OpenKey; paste the XXXX-XXXX code
tinycloud courier inbox
tinycloud courier --help
```

## Operations coverage

The migrated `tinycloud secrets get` path is owned by `@tinycloud/operations` and
uses delegated authority by default. `tinycloud auth import` is partially migrated:
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
tinycloud init

# Authenticate via browser
tinycloud auth login

# Authenticate on a remote/headless machine: the owner approves an explicit
# manifest on their phone (URL + code printed to stderr). Use a new profile
# name if it already exists; keep the user's existing profiles.
tinycloud init --name publisher --key-only
tinycloud --profile publisher auth login --device --manifest builtin:share-publishing

# Same Share publishing scope, as a shortcut (on the dedicated profile)
tinycloud --profile publisher enable share

# Selected profile, owner, host and space (JSON; does not test access)
tinycloud context

# Store and retrieve data
tinycloud kv put greeting "Hello, world"
tinycloud kv get greeting
tinycloud kv list

# Manage network-encrypted secrets on the default network
tinycloud secrets network init
printf '%s' "$ANTHROPIC_API_KEY" | tinycloud secrets put ANTHROPIC_API_KEY --stdin
tinycloud secrets get ANTHROPIC_API_KEY
tinycloud secrets run ANTHROPIC_API_KEY -- python train.py   # the value only in the command's environment

# Ask the owner for a secret an agent needs, then wait for it
# (call TinyCloud's CLI by absolute path when using tc: a bare tc can be iproute2's /usr/sbin/tc)
tinycloud --profile agent secrets request OPENAI_API_KEY --json   # offline; prints the owner's link
tinycloud --profile agent secrets wait OPENAI_API_KEY --timeout 9m --json   # 0 ready, 8 pending

# Manage spaces
tinycloud space list
tinycloud space create

# Grant access to another user
tinycloud delegation create --to did:pkh:eip155:1:0x...
```

## Home feed

`tinycloud feed` uses separate owner-provisioned SQLite databases for each agent's
cards/handling and the owner's append-only responses. Owner registry and view
state live separately. SDK consumers use the same contract from
`@tinycloud/sdk-services/feed` with existing SQL database handles; see the
[canonical types](../sdk-services/src/feed/types.ts).

Use an authenticated **owner-openkey or local-owner-key** profile for `connect`.
That owner needs SQL read/write/schema authority for
`xyz.tinycloud.tinychat/home_feed` and the `xyz.tinycloud.tinychat/feed/`
namespace, plus authority to delegate the exact agent grants below. The trailing
slash denotes a database namespace, not an individual database.

Create a separate agent profile and set `AGENT_DID` to its printed DID. Use the
same node as the owner:

```bash
tinycloud profile create feed-agent --posture delegate-session --operator agent
tinycloud --profile owner feed connect --agent writer --to "$AGENT_DID" --label Writer \
  --space applications > feed-grant.json
tinycloud --profile feed-agent auth import feed-grant.json
```

`connect` reserves a stable token/DID/resource binding, provisions both schemas,
and activates one bundled delegation through the existing SDK. It registers
actual grant provenance only after activation; a failed activation may be
retried with the same DID and resources. The agent receives read/write on
`xyz.tinycloud.tinychat/feed/feed_output_writer`, read on
`xyz.tinycloud.tinychat/feed/feed_responses_writer`, and hook subscription on
`sql/xyz.tinycloud.tinychat/feed/feed_responses_writer`. Agents do not receive
response-write or schema authority. Display labels and tokens select resources;
the signed grants determine access.

Publish `card.json` from the agent profile:

```json
{"cardId":"card-draft-01","revision":1,"issuanceId":"issuance-draft-01","kind":"decision","needsResponse":true,"title":"Create draft?","body":"Create a reversible draft only.","choices":[{"id":"create","label":"Create draft"}],"urgency":1,"createdAt":"2026-10-29T00:00:00Z"}
```

```bash
tinycloud --profile feed-agent feed publish --agent writer --file card.json
tinycloud --profile feed-agent feed watch --agent writer --recipient agent-runtime \
  --runner '["node","agent-handler.js"]'
```

Run `watch` in the agent terminal, then save `response.json` from the owner
profile in another terminal, or answer the card through Home:

```json
{"responseId":"response-draft-01","cardId":"card-draft-01","revision":1,"issuanceId":"issuance-draft-01","kind":"answer","choiceId":"create","createdAt":"2026-10-29T00:01:00Z"}
```

```bash
tinycloud --profile owner feed respond --agent writer --file response.json
tinycloud --profile feed-agent feed responses --agent writer --after 0
tinycloud --profile feed-agent feed handling --agent writer --file handling.json
tinycloud --profile owner feed show card-draft-01 --agent writer
```

For an explicit outbound note to that agent, save a separate `message.json`:

```json
{"responseId":"message-draft-01","cardId":"card-draft-01","revision":1,"issuanceId":"issuance-draft-01","kind":"message","text":"Please explain the draft before I answer.","createdAt":"2026-10-29T00:02:00Z"}
```

```bash
tinycloud --profile owner feed message --agent writer --file message.json
```

Messages also work on information cards with `needsResponse: false`. They do not
answer a card, clear Needs action, or replace its current answer or handling.
`choiceId` and `supersedesResponseId` are refused on messages. Agent response pages
and watch include messages, with acknowledgements/outcomes tied to their own full
response IDs. Private owner notes, task ticks, and seen state remain owner-only
registry data; they are not outbound messages.

For a new response with private structured data, `payload.json` is a versioned
JSON envelope, for example:

```json
{"type":"example.private-action","version":1,"data":{"code":"SYNTHETIC-ONLY"}}
```

Include it on the **first** save, instead of the plain `respond` command above:

```bash
tinycloud --profile owner feed respond --agent writer --file response.json --payload-file payload.json
tinycloud --profile feed-agent feed payload --agent writer --response response-draft-01 \
  --card card-draft-01 --revision 1 --issuance issuance-draft-01
```

The header and payload commit atomically in the same owner-response database.
Retries of the same response ID must include the same header and payload; a
changed, omitted, or later-added payload is refused. `feed payload` verifies the
full response/card/revision/issuance identity, returning its envelope, or `null`
for a known response without a payload. Unknown or mismatched identities fail.
Keep approval codes in `payload.data`, never the normal response text.

Default `list`, `show`, `responses`, and `watch` output contains only response
headers and optional `payloadType`/`payloadVersion` metadata, not payload data.
The SDK equivalents are the optional fourth `appendFeedResponse` or
`appendFeedMessage` argument and the explicit `readFeedResponsePayload` method.
`feed message` accepts the same `--payload-file` option on its first save.
Owner schema initialization adds `feed_response_payloads`; existing response-read
authority also authorizes an explicit payload read. “Private” here means excluded
from notification copies, not a new authorization boundary against an agent already
granted database read.

`readFeedResponseHandling(output, identity)` reads acknowledgement and outcome for
one full response/card/revision/issuance identity, including historical answers or
messages after later arrivals. Unknown or mismatched handling returns `NOT_FOUND`,
not a synthetic empty receipt. Known acknowledgement-only or outcome-only history
retains the other slot as `null`. `getFeedCardState` selects only the current
answer/follow-up; a saved answer without handling still has `null` receipt slots.

Retain the full response ID on a retry. Reusing it with different content is
refused. Responses bind the full card ID, revision, and issuance; corrections
are new follow-up records, optionally naming `supersedesResponseId`. Short card
references work only when unambiguous. Handling records carry their own
`handlingId`, the response/card identities, `createdAt`, and `phase`:
`acknowledged`, `succeeded`, or `failed`, with optional structured `detail`.
Acknowledgement history and the terminal outcome are retained independently.

**Saved, delivered, acknowledged, and completed are different states.**
The runner receives allowlisted response-header JSON and optional payload
type/version metadata on stdin through an argv array, never shell interpolation.
Exit zero must mean durable acceptance of that response ID, not completion of
its action. The agent publishes acknowledgement and outcome through `handling`.

`watch` requires **Bun or Node.js 22.13+** for its durable local SQLite ledger;
other commands keep the CLI's Node.js 20 requirement. By default the ledger is
stored under the selected profile; `--handoff` selects another durable file.
The listener subscribes before draining and reconciles on readiness, writes,
reconnects, and five-minute renewal, without a rapid idle query loop.

Before attempting a send, the ledger records `unconfirmed`. A crash, uncertain
runtime result, or interruption leaves that identity unconfirmed rather than
automatically sending again. A `prepared` record can resume only before an
attempt began. Ctrl-C/SIGTERM stops the watcher and forcibly terminates its
current runner; an already-started action may still have happened. Keep response
IDs as downstream idempotency keys where supported. Exactly-once external
execution is not promised.

## Commands

| Command | Description |
|---------|-------------|
| `tinycloud init` | Set up a profile and generate keys |
| `tinycloud auth login` | Authenticate via browser |
| `tinycloud auth login --device --manifest <file>` | Approve exactly a manifest's permissions on another device (phone) |
| `tinycloud auth login --manifest <file>` | Browser OpenKey login scoped to a manifest |
| `tinycloud enable share` | Device login with the built-in Share publishing manifest (use a dedicated profile) |
| `tinycloud context` | Show the selected profile, owner, host, space and session state |
| `tinycloud auth status` | Show authentication status |
| `tinycloud auth whoami` | Show current identity |
| `tinycloud auth request --preset apps-agent [--app <id>]... [--write]` | Request access for an agent to the user's installed apps: read-only by default, for one app, several, or all. `--write --app <id>` also lets the agent change that app's data: write its `knowledge/` and `prefs/` files and add, change or delete its table rows. For the Health Log app's catalog database, it can also create, change and drop tables (nodes before 1.21.6 do not enforce that split). It cannot change the app's code, manifest or install record |
| `tinycloud knowledge list` | List the installed apps that have a knowledge bundle |
| `tinycloud knowledge read <app_id> [concept]` | Read an app's knowledge index, or one concept with its frontmatter parsed |
| `tinycloud apps install <app_id>` | Install a pinned catalog app into the applications space of the profile it runs under (the owner's, for a delegate profile, through its grant): each file is verified against its pinned digest, the pinned DDL runs only if every statement is allowed, and knowledge notes are created create-only. Notes you have edited are left as they are and reported (exit 0) |
| `tinycloud kv get <key>` | Retrieve a value |
| `tinycloud kv put <key> <value>` | Store a value |
| `tinycloud kv list` | List all keys |
| `tinycloud sql query <sql>` | Run a SQLite SELECT query |
| `tinycloud sql execute <sql>` | Run a SQLite write or schema statement |
| `tinycloud sql export` | Export a SQLite database file |
| `tinycloud feed` | Connect an agent, publish cards, save responses, record handling, and watch for runtime handoff; see [Home feed](#home-feed) |
| `tinycloud space list` | List your spaces |
| `tinycloud space create` | Create a new space |
| `tinycloud delegation create` | Grant access to another user |
| `tinycloud delegation list` | List delegations |
| `tinycloud delegation revoke <cid>` | Revoke a delegation. From a delegate profile, revoke one its own key issued. |
| `tinycloud share` | Share data with another user |
| `tinycloud node` | Manage TinyCloud nodes |
| `tinycloud profile list` | List profiles |
| `tinycloud profile show` | Show profile details |
| `tinycloud profile create` | Create a new profile |
| `tinycloud vault` | Manage encrypted KV vaults |
| `tinycloud secrets` | Manage network-encrypted secrets |
| `tinycloud secrets network show` | Show a secrets decryption network |
| `tinycloud secrets network init` | Create or fetch the default secrets network |
| `tinycloud secrets network grant` | Grant `tinycloud.encryption/decrypt` on a secrets network |
| `tinycloud secrets run` | Run a command with secrets in its environment |
| `tinycloud secrets request` | Print a Secret Manager link asking the owner to add secrets (offline) |
| `tinycloud secrets wait` | Wait until secrets exist and are readable (never signs in; needs a stored session; exit 8 pending, 130 interrupted) |
| `tinycloud secrets manage` | Print or open the Secret Manager page, `{url, opened}` |
| `tinycloud vars` | Manage environment variables |
| `tinycloud doctor` | Run diagnostic checks |
| `tinycloud completion` | Generate shell completions |
| `tinycloud courier` | Agent-to-agent threads over TinyCloud (beta; see [Courier](#courier)) |

Secret names are env-style uppercase identifiers such as `FIREFLIES_API_KEY`.
`tinycloud secrets network show` accepts either a short network name or a full
`urn:tinycloud:encryption:<ownerDid>:<network>` identifier. `tinycloud secrets
network grant` takes the short name, resolves the network, and grants
`tinycloud.encryption/decrypt`.

`tinycloud apps install` re-creates the pinned views on every run (reported as
`viewsRecreated`). Knowledge notes whose bytes differ from the pinned version
are left as you edited them and listed under `conflicts` (JSON); the command
still exits 0 and installs the rest. If the schema fails after notes were
written, it says "notes saved; tables not set up: run again"; running it again
is safe.

### Running a command with secrets

```bash
tinycloud secrets run NAME... [--map NAME=ENV_VAR]... [--scope S] [--space S] [--delegation SOURCE] [--private-key HEX] -- <command> [args...]

tinycloud secrets run ANTHROPIC_API_KEY OPENAI_API_KEY -- python train.py
tinycloud secrets run --map ANTHROPIC_KEY=ANTHROPIC_API_KEY -- node server.js
```

`tinycloud secrets run` reads every named secret as `tinycloud secrets get` does, then
starts `<command>` directly, without a shell, with each value in its
environment: under the secret's name, or under `ENV_VAR` for `--map
NAME=ENV_VAR`. A value replaces an inherited variable of the same name.
tinycloud doesn't pass its own `TC_PRIVATE_KEY` to the command. To give the command
a key from a secret, use `--map NAME=TC_PRIVATE_KEY`.
Everything after the first `--`, including any further `--`, goes to the
command unchanged. The command uses tinycloud's stdin, stdout and stderr; tinycloud itself
writes nothing to stdout, and its own messages go to stderr.

Name at least one secret, as an argument or with `--map`. `ENV_VAR` must
match `[A-Za-z_][A-Za-z0-9_]*`, and two secrets cannot be mapped to the same
variable (exit 2). If any secret cannot be read, the command does not start
and tinycloud exits with the code and error `tinycloud secrets get` gives for that secret.
Otherwise tinycloud exits with the command's exit code. If the command was ended by
SIGINT, SIGTERM, SIGHUP, SIGKILL, SIGALRM or SIGUSR2, tinycloud ends by the same
signal (or exits with 128 plus the signal number if that signal doesn't end
tinycloud). If any other signal ended it, such as SIGQUIT or SIGSEGV, tinycloud exits with
128 plus the signal number instead, so tinycloud does not cause a core dump
(SIGUSR1 and SIGPIPE are left out too: Node uses SIGUSR1 for its inspector
and ignores SIGPIPE).

SIGINT, SIGTERM, SIGHUP and SIGQUIT sent to tinycloud go to the command. When tinycloud
runs in the foreground of a terminal, it doesn't pass on SIGINT, SIGQUIT or
SIGHUP: the terminal already sends them (Ctrl-C, Ctrl-\, hangup) to the
command, so the command normally gets each one once. tinycloud checks whether it's
in the foreground using `/proc`, or `ps` where `/proc` isn't available. If
neither works, it passes the signals on. When tinycloud runs in the background, it
passes them on, so a signal sent to the whole job (for example `kill -INT
%1`) can reach the command twice.

From a script, stop the command by sending SIGTERM to tinycloud's process ID. tinycloud
passes it on, waits for the command to exit, then exits the way the command
did (the command's own exit code if it handles SIGTERM itself). If the
command ignores SIGTERM, tinycloud keeps waiting.

A command that does not exist exits 127; one that cannot be executed, or
cannot be started for another reason, exits 126. These cases print one plain
line on stderr, even with `--json`: `tinycloud secrets run: <command>: command not
found`, `…: permission denied` or `…: cannot run (<error code>)`.

Limits: `tinycloud secrets run` keeps values out of the command line, your shell
history and tinycloud's own output. It doesn't hide them from the command: the
command, and anything it starts, receives the values and can print, log or
pass them on. Other programs running as the same user can often read a
process's environment too.

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
`tinycloud auth login --replication-prefix notes/`; saved prefixes are reapplied on
later logins and rotation. Prefixes are folders (`notes/`) or `/` for the
whole space. Whole-space replication requires `kv-sync-root` support and
`--replication-allow-secrets`, because it includes `vault/`. Replication needs
unrestricted `get` and explicit `sync` on that folder or broader; an exact-key
grant never qualifies. Bare replica prefixes are rejected; use `notes/`.

An explicit local-owner sign-in saves the verified replica lifecycle stamp with
its session; later CLI processes validate that stamp before local reads. Without
it, network sign-in and KV reads still work, but local replica reads stay gated
until a new verified sign-in. A gated root prefix does not imply `kv-sync-root`
support.

Replica-enabled OpenKey login uses the SDK-prepared SIWE approval URL, not the
older browser-created session. Specify `--owner did:pkh:eip155:CHAIN:ADDRESS`
unless this profile already has a verified owner session. The CLI verifies the
signed result before saving its new key, session and replica stamp. Safari, and
Chromium browsers that enforce Local Network Access without granting it (headless
Chromium cannot show the prompt), may block the HTTPS page's plain-HTTP loopback
callback: use an interactive CLI terminal and paste the same one-line code shown
by OpenKey, or start with
`tinycloud auth login --method openkey --replication-prefix notes/ --owner DID --paste`
for a headless terminal. Non-TTY `--no-popup` cannot accept a paste; if that
callback fails, it exits nonzero at the five-minute expiry with a `--paste`
retry hint and discards the candidate key. Restarting requires a new approval
and cannot reuse the old signed code. Ctrl-C, SIGINT or SIGTERM before approval
arrives cancels the OpenKey handoff (best effort) and exits 130 `CANCELLED`
without saving a key or session.

Normal OpenKey login prints a short approval link on stderr and waits. Relay it
to the owner from a headless or remote CLI; no localhost callback or pasted code
is needed. `--no-popup` skips opening a local browser, not automatic result
retrieval. The CLI verifies the encrypted result, durably saves it, then
acknowledges delivery. Re-run the same command after an interruption to resume.
The one-hour request expiry is independent of the requested grant lifetime and
result retention. Normal login keeps its seven-day default; onboarding requests
30 days explicitly. `--paste` remains an explicit manual fallback with a
five-minute, single-use return code, not the automatic short-link transport.

Use `tinycloud replica report` for read-only aggregates of persisted replication events
and identity partitions. Live replica status is unavailable there. Report
`--purge` and `--clear-pending` refuse with exit 2 `REPORT_READ_ONLY`.
`tinycloud replica reset --replica <name> --purge` is a partial alternative for a
named local replica only. Flag-owned purge and pending clearing have no
equivalent yet (TC-1309). On macOS and Windows, `replica reset --purge` and
`auth logout` with a legacy `replicas/` tree refuse local removal rather than
delete through an unpinned path; leave that tree intact and retry on a supported
platform.

`auth logout` durably fences replica reads, removes both legacy replicas and the
flag-owned `replication/` root, and shreds `session.json` and `key.json`. If
erasure fails, the marker keeps reads denied and startup retries cleanup. An
explicit logout also blocks implicit sign-in with the stored profile owner key;
use `auth login` to establish a fresh session. Unknown legacy or flag-owned
paths, an unverified legacy SQLite schema, or an unreadable gate refuse logout
before a marker, credential deletion, or node revocation. Sync local writes or
pass `--discard-local-changes` to approve the displayed paths, types and file
identities; newly added or changed paths require fresh approval. With `auth
logout --revoke --discard-local-changes`, physical files and credentials remain
through partial or failed node revocation. Only after every exact-CID receipt
does local cleanup begin. After a failed revoke, plain `auth logout` first
compares the original approved inventory. If it changed, even
`--discard-local-changes` refuses without deleting credentials or files and
prints the changed identities and a 32-character approval token. Run a separate
`auth logout --discard-local-changes --approve-inventory <token>` to approve
that exact inventory; a new change invalidates the token. After successful
remote revocation, a cleanup mismatch retains the marker and remaining files
while the profile stays signed out; `auth logout --discard-local-changes`
reapproves cleanup without repeating node revocations. OpenKey owner revocation
fails closed with `REVOCATION_AUTHORITY_UNAVAILABLE`, retaining credentials and
denied replica files until signed owner revoke authority is supported.
`--keep-replicas` is available only for legacy-only profiles with no gate,
flag-owned partition or pending purge; it retains those legacy files but still
shreds credentials and blocks implicit reauthentication.
When the profile's replica gate belongs to a different account than the
signed-in session, `auth logout` signs that session out and removes the
profile's legacy `replicas/` tree, but leaves the other account's gate and
flag-owned replicas untouched; startup finishes the legacy removal if it is
interrupted. If an earlier sign-out was interrupted, logout reports it and a
second `auth logout` completes it. A gate that no longer matches its logout
record (for example, restored from an older copy) refuses logout; switch the
default profile if needed, then run `tinycloud profile delete <name>` and sign in
again.

`auth logout`, `auth rotate`, and replica-enabled `auth login` that replaces the
profile's share-history key check the sender share history first. If it records
unexpired shares, or cannot be read, the command refuses with exit 5
(`SHARE_HISTORY_UNEXPIRED` or `SHARE_HISTORY_UNAVAILABLE`) and changes nothing.
Pass `--force` to proceed anyway; `auth logout --revoke` also skips the check. A
plain re-login that keeps the key is not checked, and local-owner profiles are not
checked. `tinycloud share history recover` moves an unreadable history file aside to
`share-history-v2.json.unreadable-<UTC timestamp>` and reports the new path. It
never deletes or overwrites a file. If the file exists but cannot be read,
recover exits 1 with `SHARE_HISTORY_RECOVER_FAILED` and moves nothing.

`tinycloud auth grants list` labels the signed-in delegation CID `(current session)`.
`tinycloud delegation revoke <cid>` still accepts any eligible exact CID, but when
`<cid>` is the current session it requires `--yes` or an interactive confirmation
before contacting the node. An exact-CID success then runs the same durable
local sign-out and key shred as `auth logout`; revoking another CID leaves the
session intact.

B-int release acceptance must
verify the OpenKey `tinycloud auth request --grant` fallback against a real OpenKey
using a test account and no production writes: approve the request, confirm the
grant is stored, start a fresh process, and verify the saved prefixes are
replayed and the covered read is served locally. If OpenKey rejects explicit
`kv/get` plus `sync`, stop before release and resolve the protocol contract.

## Output Modes

`tinycloud` auto-detects your terminal:

- **Interactive (TTY)** — human-friendly output with colors, tables, and status icons
- **Piped / redirected** — structured JSON for scripting
- **`--json` flag** — force JSON output in any context

```bash
# Human-friendly table
tinycloud kv list

# JSON for scripting
tinycloud kv list --json
tinycloud kv list | jq '.[]'
```

## Diagnostics

```bash
tinycloud doctor
```

Checks Node.js version, profile configuration, keys, session status, node connectivity (with latency), and space availability. Outputs actionable guidance for any failing checks.

## Profiles

`tinycloud` supports multiple profiles for different environments:

```bash
tinycloud profile create staging --host https://staging.tinycloud.xyz
tinycloud profile list
tinycloud kv list --profile staging
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

`tinycloud auth login --method openkey` and `tinycloud auth request` honor this for the
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
