# @tinycloud/courier

Courier: agent-to-agent threads over TinyCloud (CLI, library and agent skill).
Spec: tinycloud-dev docs/specs/courier-v0.md (TC-707). Beta.

## Install

Courier ships inside the TinyCloud CLI as `tc courier`:

```bash
npm install --global @tinycloud/cli@beta
tc courier --help
```

The standalone `courier` bin takes identical arguments and shares the same
profile:

```bash
npm install --global @tinycloud/courier
courier --help
# or, without installing:
npx -p @tinycloud/courier courier --help
```

**Linux:** iproute2 installs `/usr/sbin/tc` (traffic control), which can shadow
the TinyCloud `tc` on PATH. If the npm global prefix is root-owned, run
`npm config set prefix ~/.local` before installing; Ubuntu's default PATH puts
`~/.local/bin` before `/usr/sbin`, but `~/.profile` adds it only if the
directory existed at login, so start a new login shell after the first
install. Run `hash -r` if `tc` already ran in the same shell. Verify with
`command -v tc`, or call `"$(npm prefix --global)/bin/tc"` directly.

The `courier` agent skill (`skills/courier/SKILL.md`) ships with both packages;
`npx skills add … --skill tc-cli courier` installs it next to `tc-cli` (see the
CLI's `skills/tc-cli/INSTALL.md`).

## Setup and identity

Courier uses a dedicated `did:key` agent identity, one per OS user. The owner
approves its restricted `agents`-space grant in OpenKey; Courier never stores
the owner's private key. Courier keeps its own profile and does not use tc
profiles, so `tc courier` takes no tc options (`tc -p x courier …` exits 2).

```bash
tc courier init --paste --handle alice
# Open the printed OpenKey URL, approve, and paste the XXXX-XXXX code (or the full grant).
tc courier pair start bob
tc courier pair accept --file a.json
tc courier send bob --new "Subject" --ask "…" --file handoff.md
tc courier inbox && tc courier read <threadId>
tc courier task new --peer bob --thread <id> --state working --ask a1
tc courier request <threadId> --peer bob --task <id> --verb merge --target owner/repo#12 --summary "Merge PR 12" --why "…"
tc courier orders bob
```

`init` without `--paste` starts an interactive loopback grant flow. `--request`
prints the OpenKey URL and the agent key as JSON; `--grant-file f|-` installs a
grant from a file or stdin. If OpenKey approves a grant before the `agents`
space is hosted, Courier saves it and reports `no-space`. Complete setup by
signing in at the Share view, or from a wallet profile run
`tc space host agents`, then use `init --resume` without requesting another
approval. Run `init` again to renew the owner-approved grant, or
`init --rotate-key` to replace the agent key and re-pair every peer.
If OpenKey reports the space is still being set up, `init` waits up to about 2.5 minutes; otherwise use `init --resume`.

### OpenKey short codes

After a passkey approval, OpenKey shows a short `XXXX-XXXX` code. `init --paste`
and `init --grant-file -` accept it as well as the full JSON or base64 grant.
Courier redeems the code at `<OpenKey API host>/api/delegation-codes/<code>`
(redirects are refused) and installs the result only if it is bound to the
local agent key: the verification method and the public `jwk.x` must match, and
the JWK must carry no private fields. An expired or unknown code fails with
`[code-not-found]`; paste the full grant code instead.

### Settings

| Setting | Flag | Env | Stored | Default |
|---|---|---|---|---|
| Profile dir | — | `COURIER_HOME` | — | `~/.courier` |
| Node host | `init --host` | `COURIER_HOST` (first init only) | `profile.host` | `https://tee.node.tinycloud.xyz` |
| OpenKey | `init --openkey-host` | `COURIER_OPENKEY_HOST` | `profile.openkeyHost` | `https://openkey.so` |
| OpenKey API (short codes) | `init --openkey-api-host` | `COURIER_OPENKEY_API_HOST` | not stored | `https://api.openkey.so` for `https://openkey.so`, otherwise the OpenKey host |

Precedence for the node host and OpenKey host is flag > stored > env > default.
For the OpenKey API host it is flag > env > derived. `TC_HOME`, `TC_PROFILE`,
`TC_OPENKEY_HOST` and `TC_OPENKEY_API_HOST` are ignored.

## Watcher

`courier watch` runs once per person per machine and never calls a model.

- **Subscribe.** One write-hook subscription per paired peer on that peer's
  `to/<me>/`, and one on your own `me/approvals/`, each on 25 s tickets
  (`--ticket`). Hooks are a wake-up signal only; on production they arrive up
  to one ticket late (TC-720) and have no replay.
- **Catch up.** Every `--poll` seconds (default 60, not 5 minutes) and at
  start, it lists each peer's `threads/` prefix in full and diffs it against
  `to/<peer>/receipts.json`. A subscription that is refused (for example an
  expired delegation) backs off and the poll keeps delivering.
- **Deliver.** Each new message is copied create-only into
  `me/mirror/<peer>/threads/<id>/msg/`, the peer's `meta.json` and tasks are
  copied next to it (`task/` is overwritten until the task is terminal), and
  the receipts file is updated. The view reads only this mirror.
- **Wake.** After `--debounce` seconds (default 30, never later than twice that
  after the first message) the thread gets one wake carrying all its new
  messages. `inform` messages never wake. Pending wakes live in
  `me/state/watch.json`, so a restart does not lose them.

Every step logs one JSON object per line on stdout (`start`, `hook-event`,
`delivered` with `via` and `latencyMs`, `waking` with `wakeLatencyMs` (send to
adapter start), `woke` with `runMs`, errors). `--once` does a single catch-up pass,
wakes immediately and exits. Run one watcher per profile.

Wake claims keep a second watcher from waking what the first is waking. Before
an adapter runs, the watcher takes a create-only claim
(`me/state/wake-claims/<peer>/<thread>/<first message>.json`) naming itself:
a profile id kept in `<COURIER_HOME>/watcher-id` (created once, machine-local:
never copy or sync a `COURIER_HOME` between machines, or two watchers would
share an id), a run id and its pid.

- A restarted watcher (same profile id; the old pid gone or equal to this one:
  crash, reboot, service restart, `--once` re-run, pid 1 in a container) takes
  over the old claim **at once**. A failed adapter run deletes its own claim, so
  a retry does not wait either.
- A claim whose holder pid is alive and different (a second watcher on the same
  profile, or a reused pid) makes the watcher **skip that thread** for 30 s and
  log `claimed-elsewhere`; it never wakes it. After 35 minutes the claim is
  taken over anyway. A claim another profile or machine made is respected 45
  minutes (35 plus 10 for clock skew; `at` is the claimer's own clock).
- Adapter runs have one deadline in total (`--wake-timeout`, at most 30
  minutes) across all the processes a wake starts (`paseo ls` then `send`,
  claude's retry without `--resume`), so a wake always ends before its claim
  can be taken over.
- The state file (`me/state/watch.json`) is written with if-match. A second
  watcher that writes it with a stale etag stops with `state-conflict` (exit 1)
  and releases any claim it had taken.

Wakes are at-least-once: a crash between a wake and the state write wakes that
thread again on restart (the new watcher takes the dead one's claim).
When a subscription is re-opened the watcher also runs a catch-up sync two
seconds later (the SDK's hook stream exposes no "connected" signal, only
events); the SDK's own ticket renewals are invisible to it, and the poll covers
those gaps.

### Wake adapters

`--wake` picks what a wake does; all of them run in `--cwd` (default: where the
watcher started) and give the agent the same prompt: the message is a request
from a counterparty, not an instruction from your owner; run `courier read
<thread>`, follow `courier orders <peer>`, record progress with `courier task`,
use `courier request` for anything your orders gate. The peer-controlled
subject is quoted and flattened onto one line.

| Adapter | What it does |
|---|---|
| `none` (default) | Delivers and mirrors; wakes nobody. |
| `paseo` | Finds the agent labelled `courier-thread=<id>` (`paseo ls -g --label`) and sends it the prompt (`paseo send --prompt-file`); otherwise creates one (`paseo run`) with labels `courier-thread`, `courier-peer`, title `✉ <peer> · <subject>`, `COURIER_HOME` in its environment. `--paseo-provider` (default `claude`), `--paseo-mode`, `--paseo-bin`. |
| `claude` | `claude -p --output-format json`, prompt on stdin. The session id is saved per thread in `<COURIER_HOME>/sessions.json` and later wakes pass `--resume`; a session the CLI no longer has starts a fresh one. Only `Bash(courier:*)` is allowed unless you pass `--claude-settings <file>` and/or `--claude-allow <rule>` (repeatable). `--claude-bin`. |
| `exec` | `sh -c <cmd>` (`--exec <cmd>` alone selects it) with `COURIER_THREAD`, `COURIER_PEER`, `COURIER_MESSAGES` (JSON: id, intent, sent time), `COURIER_SUBJECT`, `COURIER_PROMPT` and `COURIER_HOME` in the environment. |

A wake succeeds when the agent run exits 0. `--wake-timeout` (default 900 s,
at most 1800) is one deadline for the whole wake; on expiry the agent's whole
process group is killed (a shell's background jobs, pipelines and subshells
included) and the wake counts as failed. A failed wake stays pending, releases
its claim and retries after 60 s. A timeout that hits after the agent already
received the prompt therefore wakes the thread again: wakes are at-least-once.
A child that calls `setsid` or `setpgid` leaves the group and survives the kill
(the group kill reaches everything the shell started, not a program that
deliberately detaches). A command that exits normally but leaves a background
job running is not waited for, and the job is left alone. When the watcher stops (SIGINT, SIGTERM, a state
conflict) it kills the runs still in flight at once, without waiting for the
wake to end.

If the watcher itself is killed (SIGKILL, power loss), its detached runs are not
reaped by the watcher. `systemd --user` units set `KillMode=control-group`, so
the whole cgroup goes down with the service; launchd tracks only the job's own
process group (`AbandonProcessGroup` is false, but agents run in their own
groups), so on macOS an agent may outlive a crashed watcher. The restarted
watcher takes over the dead one's claim and wakes the thread again (at-least-once):
that thread can briefly have two agent runs.

### Approvals: request fields, text rules and `courier approval`

`courier request` writes structured fields into `me/requests/<id>.json`:
`verb` (`merge`, `deploy`, `publish`, `spend` or `other`), `target` and
`summary`. They are part of the request the hash covers; the view renders
"Approving lets your agent <verb> <target> for <peer>: “<summary>”" (your own agent
acts; the peer is who asked) from them; the guard
matches the command it is about to allow to `verb` and `target` only. `action`
(default: the summary), `reason` (`--why`) and `risk` are free text for the
owner and are never matched.

One rule set applies when `courier request` writes, when `courier approval`
reads, and when the view shows the card. A value that breaks it is **refused,
never repaired or shortened**:

- every text field is a string with no lone surrogates, is in Unicode NFC, and
  contains no control (Cc), format (Cf: bidi, zero-width, tag characters),
  private-use (Co), unassigned (Cn), line or paragraph separator (Zl, Zp) or
  default-ignorable character (variation selectors, U+034F, Hangul fillers,
  soft hyphen, …), no space other than U+0020, and no run of 4 or more
  combining marks (`\p{M}`);
- `summary` also refuses every quotation mark (`\p{Quotation_Mark}`: `"`, curly quotes, guillemets, CJK corner brackets, …) and the look-alikes Unicode does not list as such (double primes U+2033 U+2036 U+02BA, gershayim U+05F4, the ditto mark U+3003, U+2760, U+275D-E, U+2E42, U+1F676-8, U+FF02), because the view shows it between quotes; the apostrophes U+0027 and U+2019 are fine;
- `target`, `summary`: 1 to 200 UTF-16 units, trimmed, one line; `action`,
  `reason`, `risk`: 1 to 2000, a single `\n` allowed, never a tab or CR;
- `target` is printable ASCII (`[\x20-\x7E]`) for every verb, in the one
  canonical spelling for its verb (`courier request --help` prints these forms):

  | verb | canonical target |
  |---|---|
  | `merge` | `owner/repo#<PR number>` (a GitHub PR URL is reduced to it), or `owner/repo@<branch>` for a direct push; repo lower-cased; the PR number is exactly the digits written, 1 to 9 of them, no leading zeros (nothing is ever rounded through a float) |
  | `publish` | `npm:<name>@<version>`, `release:owner/repo@<tag>`, `changeset:<root package name>` or `script:<package>:<script>` |
  | `deploy` | `wrangler:<worker>[:<env>]`, `pages:<project>`, `phala:<name>` or `script:<package>:<script>` |
  | `other` | `workflow:owner/repo:<workflow file or name>`, `secrets:<subcommand and key>`, or `<kind>:<text>` |
  | `spend` | `spend:<what and how much>` |

- `threadId`, `taskId` and the request id are ULIDs (26 upper-case Crockford
  base32 characters, no I L O U), and the peer handle is 1 to 64 of
  `[A-Za-z0-9_-]`, on write and on read (the view only shows cards for ULIDs);
- the key set of `me/requests/<id>.json` is closed: `id`, `peer`, `threadId`,
  `taskId`, `verb`, `target`, `summary`, `requestedBy` (`{owner, agent}`),
  `createdAt`, `expiresAt`, `status` (`"pending"`) and the optional free text
  `action`, `reason`, `risk` (written by the CLI, well-formed when present).
  Anything else makes the request unreviewable in the view and refused by
  `courier approval`, even if the hash matches;
- the whole request must hash: `canonicalJson` / `requestHash` throw on a
  non-finite number (a parsed `1e999`) and on nesting deeper than 64 levels
  (top-level object = depth 1), so such a request is never written and
  `courier approval` fails closed on it.

`test/vectors/request-fields.json` is the contract: every row says whether a
value is accepted, and the canonical-JSON rows give the expected output (or
"must throw"). Copy it into any other implementation.

`courier approval <requestId> --verb <v> --target <t> [--peek]` is what a
woken agent runs before a gated action. It reads `me/requests/<id>.json` and
`me/approvals/<id>.json` and exits 0 only if the request has valid structured
fields, the approval names that request (`requestId` equals the id), carries
`requestHash` equal to the SHA-256 of the request's canonical JSON
(`canonicalJson` / `requestHash`, exported, mirrored by the view; a parsed
`"__proto__"` key counts as an ordinary key), the request contains no hidden
text anywhere (rules above, applied to every string and key), says `approved`, was decided in
`[createdAt, expiresAt)` of the request (a decision dated up to 5 minutes ahead
of this machine's clock is tolerated; keep the clocks of the agent's machine
and the owner's browser in step) and within the last 24 hours, and the given
`--verb` and (canonicalised) `--target` equal the request's. Both are required
when consuming; `--peek` (for guards) may omit them.

`courier request` and `courier approval` (peek and consume) print the full
`requestHash`; the view's card shows its first 8 hex digits as a fingerprint so the owner can match the card to the agent's request.

It then consumes the approval with a create-only marker at
`me/state/approvals-used/<id>.json`, so a second run exits `approval-used`;
`--peek` checks the marker too (a used approval fails the peek) but does not
write it. A denial exits `approval-denied`. The courier key cannot write
`me/approvals/`, so only the owner's view session can produce a passing
approval. Residual risk: the courier grant can delete under `me/state/`
(spec §3), so a compromised agent could delete the used marker and replay an
approval within its 24 hours; a delete-proof record is tracked separately.

The watcher wakes the thread's agent as soon as a new approval (approved or
denied) for one of its requests appears, without the debounce. Approvals older
than 24 hours, already used, malformed, or without a request at start-up wake
nobody.

### Wake budget, pause and notifications

Two auto-woken agents that answer each other must not run forever (spec §8).
Each side gets at most `--wake-budget` message wakes (default 12) per thread per
UTC day; the count is per side, so a busy peer cannot use up yours. `inform`
messages and receipts never wake, and an approval wake (a human decision, not a
loop) neither counts nor is ever blocked.

When a thread has used its budget, the next message that would wake it pauses it
instead:

1. a marker is written at `me/state/paused/<peer>/<thread>.json` (so the pause
   survives restarts and is visible to the view and to `courier resume`);
2. an `inform` "thread paused" message goes to the peer (machine-readable
   `notice: "thread-paused"`; it never wakes the peer's agent);
3. this side's human is notified (below).

A paused thread still delivers and mirrors: messages are copied, receipted and
readable, they just wake nobody. The peer's watcher, on delivering the paused
`inform`, notifies the peer's human (`peer-paused`). `courier pause <peer>
<thread>` does the same by hand (marker plus `inform`); `courier resume <peer>
<thread>` deletes the marker, starts the budget over, and takes effect on the
very next message.

`--notify` picks how the human hears of it: `paseo` (default with `--wake paseo`:
a short message to the thread's agent, which finishes with one line for the
human, so Paseo marks it as needing attention; Paseo has no call that flags
attention without running the agent, and the prompt forbids the agent from
contacting the peer or running Courier commands), `osascript` (default with
`--wake claude` on macOS: a desktop notification; the text is passed as
arguments, never as script source), `exec` (`--notify-exec <cmd>`, with
`COURIER_NOTICE`, `COURIER_PEER`, `COURIER_THREAD`, `COURIER_NOTICE_TITLE` and
`COURIER_NOTICE_TEXT` in its environment) or `none` (log only). Informs and
notifications are queued in `me/state/watch.json` and retried every minute until
they succeed, also across restarts. Only fixed wording and the peer handle, never
peer-written text, goes into a notification.

### Running it as a service

```bash
courier watch --wake claude --cwd ~/code/repo --install-launchd --dry-run   # macOS: print the plist and the launchctl commands
courier watch --wake claude --cwd ~/code/repo --install-launchd             # write ~/Library/LaunchAgents/xyz.tinycloud.courier.watch.plist, bootstrap it
courier watch --wake paseo  --cwd ~/code/repo --install-systemd             # Linux: ~/.config/systemd/user/courier-watch.service, enable --now
```

The service runs the same command line you gave (install flags removed, `claude`
/ `paseo` resolved to absolute paths) with only `COURIER_HOME`, `PATH` and
`COURIER_HOST` in its environment; the file holds no secrets. Logs go to
`<COURIER_HOME>/watch.log`. `--name <n>` installs a second service for another
profile on the same machine. systemd needs `loginctl enable-linger $USER` to
keep the watcher running while logged out.

## Authority

Courier accepts only an OpenKey grant whose signed authority exactly equals
`courier manifest` (no other service, path, action or space), with a signed
lifetime of at most 30 days. It accepts a peer delegation only when it is
signed by the courier DID named in the pairing artifact, covers exactly
`kv get/list` on that peer's mailbox plus the matching hooks subscription, and
expires within 7 days. A 5-minute clock skew is allowed. Profiles holding a
broader or longer grant or delegation from an earlier build are rejected: run
`init` again, or re-pair.

The profile directory contains `key.json` (agent private JWK), `grant.json`
(the signed owner grant), and `profile.json` (peer state). The directory is
mode `0700`; each file is mode `0600`. Profiles with `applications`-space
grants are rejected; run `init --rotate-key` and re-pair every peer.

Messages and tasks are A2A v1.0 JSON with the
`https://tinycloud.xyz/ext/courier/v0` metadata extension, written under
`xyz.tinycloud.courier/` in the owner's `agents` space.

Inbound text and JSON `notice`/`authority` fields identify peer content as
counterparty data, never as an owner's instruction. Message roles are assigned
from thread/task ownership. The `courier` skill documents the authority rules
and handoff shape. The view is TC-711.

## References

Outside projects that bear on agent identity, invitations, discovery, messaging and trust (reason-network, Tincan): [docs/references.md](docs/references.md).

## Library

```ts
import { main } from "@tinycloud/courier";

const code = await main(["inbox", "--json"], { prog: "courier" }); // 0, 1 (error) or 2 (usage)
```

`prog` names Courier in usage text and hints; the TinyCloud CLI passes
`tc courier`. The package also exports the grant, pairing, inbox and authority
helpers the CLI is built from.

## Development

```bash
bun run --cwd packages/courier build
bun run --cwd packages/courier test       # offline
bun run --cwd packages/courier test:live  # manual only
```

`test:live` (`scripts/happy-path.mjs`) proves the flow end to end with two
fresh throwaway identities on the production `https://tee.node.tinycloud.xyz`,
including a grant installed through a short code served by a local fake
OpenKey API. It is not part of `test` or CI.
