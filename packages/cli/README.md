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
tc secrets run ANTHROPIC_API_KEY -- python train.py   # the value only in the command's environment

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

## Home feed

`tc feed` uses separate owner-provisioned SQLite databases for each agent's
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
tc profile create feed-agent --posture delegate-session --operator agent
tc --profile owner feed connect --agent writer --to "$AGENT_DID" --label Writer \
  --space applications > feed-grant.json
tc --profile feed-agent auth import feed-grant.json
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
tc --profile feed-agent feed publish --agent writer --file card.json
tc --profile feed-agent feed watch --agent writer --recipient agent-runtime \
  --runner '["node","agent-handler.js"]'
```

Run `watch` in the agent terminal, then save `response.json` from the owner
profile in another terminal, or answer the card through Home:

```json
{"responseId":"response-draft-01","cardId":"card-draft-01","revision":1,"issuanceId":"issuance-draft-01","kind":"answer","choiceId":"create","createdAt":"2026-10-29T00:01:00Z"}
```

```bash
tc --profile owner feed respond --agent writer --file response.json
tc --profile feed-agent feed responses --agent writer --after 0
tc --profile feed-agent feed handling --agent writer --file handling.json
tc --profile owner feed show card-draft-01 --agent writer
```

For an explicit outbound note to that agent, save a separate `message.json`:

```json
{"responseId":"message-draft-01","cardId":"card-draft-01","revision":1,"issuanceId":"issuance-draft-01","kind":"message","text":"Please explain the draft before I answer.","createdAt":"2026-10-29T00:02:00Z"}
```

```bash
tc --profile owner feed message --agent writer --file message.json
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
tc --profile owner feed respond --agent writer --file response.json --payload-file payload.json
tc --profile feed-agent feed payload --agent writer --response response-draft-01 \
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

### Raw owner-only source export

`feed export` captures raw KV source bytes, not resolved Home cards or a restore plan.
Supply the full approved source space, a space-relative namespace ending in `/`,
and an unused output path. There is no installed-legacy or production default:

```bash
tc --profile owner feed export \
  --source-space tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications \
  --prefix example/legacy/ --out ./raw-owner-snapshot.json \
  --sidecars ./raw-sidecars.json
```

The selected profile must already hold source `tinycloud.kv/get` and explicit
`tinycloud.kv/sync` authority on that namespace. Normal per-agent SQL feed grants
do not authorize this export. The command does not broaden grants or fall back
to LIST when sync is denied.

`--sidecars` is optional. Its JSON array explicitly names every local file to
include; relative paths resolve beside that configuration file:

```json
[
  {"sourceKey":"owner/watch/hold-actions","sourceArea":"watch-state","path":"hold-actions.json"},
  {"sourceKey":"owner/watch/thread","sourceArea":"thread-watch-state","path":"thread-state.json"},
  {"sourceKey":"owner/expiry","sourceArea":"expiry-state","path":"expiry-state.json"}
]
```

Sidecar files are read as exact bytes, including malformed JSON or binary data.
No watcher is discovered or executed. Duplicate or conflicting full source keys
are refused rather than overwritten.

The owner-only versioned snapshot retains full KV keys, base64 bytes, SHA-256,
strong ETags, change metadata, tombstones, opaque cursors, and node source/authority
attestations. It bootstraps every change-feed page and verifies each binary network
read against its ETag. One empty final tail at the end cursor is required before
`completePrefixSnapshot: true` can be published. Source changes, cursor gaps,
scope drift, or mismatches fail the capture. The exporter does not restart a changed
capture or create a write fence; SDK requests retain their own transport behavior.

The complete file is fsynced and published exclusively with mode `0600`; an existing
path is never silently replaced. Keep this archive private: it can contain answers
or codes. Normal command output is only the snapshot ID, output path, and counts.
The output directory must belong to the effective user and forbid group/world
writes. Ancestors must belong to that user or root; writable shared ancestors
require sticky-bit protection of the next trusted-owned child. Unverifiable paths
are refused. Mode `0600` protects contents, not the staging pathname's identity:
the directory precondition prevents another UID from replacing that entry.
The same UID and root remain trusted OS principals, not isolated adversaries.
Export does not classify records, choose current answers, resolve recipients,
evaluate legacy expiry, restore state, or dispatch pending responses.

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
| `tc auth request --preset apps-agent [--app <id>]... [--write]` | Request access for an agent to the user's installed apps: read-only by default, for one app, several, or all. `--write --app <id>` also lets the agent change that app's data: write its `knowledge/` and `prefs/` files and add, change or delete its table rows. For the Health Log app's catalog database, it can also create, change and drop tables (nodes before 1.21.6 do not enforce that split). It cannot change the app's code, manifest or install record |
| `tc knowledge list` | List the installed apps that have a knowledge bundle |
| `tc knowledge read <app_id> [concept]` | Read an app's knowledge index, or one concept with its frontmatter parsed |
| `tc apps install <app_id>` | Install a pinned catalog app into the applications space of the profile it runs under (the owner's, for a delegate profile, through its grant): each file is verified against its pinned digest, the pinned DDL runs only if every statement is allowed, and knowledge notes are created create-only. Notes you have edited are left as they are and reported (exit 0) |
| `tc kv get <key>` | Retrieve a value |
| `tc kv put <key> <value>` | Store a value |
| `tc kv list` | List all keys |
| `tc sql query <sql>` | Run a SQLite SELECT query |
| `tc sql execute <sql>` | Run a SQLite write or schema statement |
| `tc sql export` | Export a SQLite database file |
| `tc feed` | Connect an agent, publish cards, save responses, record handling, and watch for runtime handoff; see [Home feed](#home-feed) |
| `tc space list` | List your spaces |
| `tc space create` | Create a new space |
| `tc delegation create` | Grant access to another user |
| `tc delegation list` | List delegations |
| `tc delegation revoke <cid>` | Revoke a delegation. From a delegate profile, revoke one its own key issued. |
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
| `tc secrets run` | Run a command with secrets in its environment |
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

`tc apps install` re-creates the pinned views on every run (reported as
`viewsRecreated`). Knowledge notes whose bytes differ from the pinned version
are left as you edited them and listed under `conflicts` (JSON); the command
still exits 0 and installs the rest. If the schema fails after notes were
written, it says "notes saved; tables not set up: run again"; running it again
is safe.

### Running a command with secrets

```bash
tc secrets run NAME... [--map NAME=ENV_VAR]... [--scope S] [--space S] [--delegation SOURCE] [--private-key HEX] -- <command> [args...]

tc secrets run ANTHROPIC_API_KEY OPENAI_API_KEY -- python train.py
tc secrets run --map ANTHROPIC_KEY=ANTHROPIC_API_KEY -- node server.js
```

`tc secrets run` reads every named secret as `tc secrets get` does, then
starts `<command>` directly, without a shell, with each value in its
environment: under the secret's name, or under `ENV_VAR` for `--map
NAME=ENV_VAR`. A value replaces an inherited variable of the same name.
tc doesn't pass its own `TC_PRIVATE_KEY` to the command. To give the command
a key from a secret, use `--map NAME=TC_PRIVATE_KEY`.
Everything after the first `--`, including any further `--`, goes to the
command unchanged. The command uses tc's stdin, stdout and stderr; tc itself
writes nothing to stdout, and its own messages go to stderr.

Name at least one secret, as an argument or with `--map`. `ENV_VAR` must
match `[A-Za-z_][A-Za-z0-9_]*`, and two secrets cannot be mapped to the same
variable (exit 2). If any secret cannot be read, the command does not start
and tc exits with the code and error `tc secrets get` gives for that secret.
Otherwise tc exits with the command's exit code. If the command was ended by
SIGINT, SIGTERM, SIGHUP, SIGKILL, SIGALRM or SIGUSR2, tc ends by the same
signal (or exits with 128 plus the signal number if that signal doesn't end
tc). If any other signal ended it, such as SIGQUIT or SIGSEGV, tc exits with
128 plus the signal number instead, so tc does not cause a core dump
(SIGUSR1 and SIGPIPE are left out too: Node uses SIGUSR1 for its inspector
and ignores SIGPIPE).

SIGINT, SIGTERM, SIGHUP and SIGQUIT sent to tc go to the command. When tc
runs in the foreground of a terminal, it doesn't pass on SIGINT, SIGQUIT or
SIGHUP: the terminal already sends them (Ctrl-C, Ctrl-\, hangup) to the
command, so the command normally gets each one once. tc checks whether it's
in the foreground using `/proc`, or `ps` where `/proc` isn't available. If
neither works, it passes the signals on. When tc runs in the background, it
passes them on, so a signal sent to the whole job (for example `kill -INT
%1`) can reach the command twice.

From a script, stop the command by sending SIGTERM to tc's process ID. tc
passes it on, waits for the command to exit, then exits the way the command
did (the command's own exit code if it handles SIGTERM itself). If the
command ignores SIGTERM, tc keeps waiting.

A command that does not exist exits 127; one that cannot be executed, or
cannot be started for another reason, exits 126. These cases print one plain
line on stderr, even with `--json`: `tc secrets run: <command>: command not
found`, `…: permission denied` or `…: cannot run (<error code>)`.

Limits: `tc secrets run` keeps values out of the command line, your shell
history and tc's own output. It doesn't hide them from the command: the
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
`tc auth login --replication-prefix notes/`; saved prefixes are reapplied on
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
`tc auth login --method openkey --replication-prefix notes/ --owner DID --paste`
for a headless terminal. Non-TTY `--no-popup` cannot accept a paste; if that
callback fails, it exits nonzero at the five-minute expiry with a `--paste`
retry hint and discards the candidate key. Restarting requires a new approval
and cannot reuse the old signed code. Ctrl-C, SIGINT or SIGTERM before approval
arrives cancels the OpenKey handoff (best effort) and exits 130 `CANCELLED`
without saving a key or session.

Use `tc replica report` for read-only aggregates of persisted replication events
and identity partitions. Live replica status is unavailable there. Report
`--purge` and `--clear-pending` refuse with exit 2 `REPORT_READ_ONLY`.
`tc replica reset --replica <name> --purge` is a partial alternative for a
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
default profile if needed, then run `tc profile delete <name>` and sign in
again.

`auth logout`, `auth rotate`, and replica-enabled `auth login` that replaces the
profile's share-history key check the sender share history first. If it records
unexpired shares, or cannot be read, the command refuses with exit 5
(`SHARE_HISTORY_UNEXPIRED` or `SHARE_HISTORY_UNAVAILABLE`) and changes nothing.
Pass `--force` to proceed anyway; `auth logout --revoke` also skips the check. A
plain re-login that keeps the key is not checked, and local-owner profiles are not
checked. `tc share history recover` moves an unreadable history file aside to
`share-history-v2.json.unreadable-<UTC timestamp>` and reports the new path. It
never deletes or overwrites a file. If the file exists but cannot be read,
recover exits 1 with `SHARE_HISTORY_RECOVER_FAILED` and moves nothing.

`tc auth grants list` labels the signed-in delegation CID `(current session)`.
`tc delegation revoke <cid>` still accepts any eligible exact CID, but when
`<cid>` is the current session it requires `--yes` or an interactive confirmation
before contacting the node. An exact-CID success then runs the same durable
local sign-out and key shred as `auth logout`; revoking another CID leaves the
session intact.

B-int release acceptance must
verify the OpenKey `tc auth request --grant` fallback against a real OpenKey
using a test account and no production writes: approve the request, confirm the
grant is stored, start a fresh process, and verify the saved prefixes are
replayed and the covered read is served locally. If OpenKey rejects explicit
`kv/get` plus `sync`, stop before release and resolve the protocol contract.

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
