# Courier QA stub peer

A development script for deterministic, local-node Courier checks. It is excluded
from the npm package (`files` contains only `dist` and `skills`). No model, human,
credits, wake adapter or notifier is used by the stub. It polls the real Courier
inbox, commits real delivery receipts, and sends fixed replies through the real
CLI. It stops on a failed node call instead of retrying failures indefinitely.

Build Courier and its SDK dependencies first. The fake OpenKey helper must support
`COURIER_FAKE_OPENKEY_HOST`; the stub sets this to its mandatory `--host` before
importing the helper. Only loopback HTTP(S) hosts are accepted. Never use a live
identity or a production node. All examples below run from `packages/courier`.

## Start and pair

```sh
node scripts/qa-stub-peer.mjs start --host http://127.0.0.1:8000 \
  --name qa-stub --peer qa-peer
```

The process stays running. Its only stdout document is
`{"ready":true,"state":"/var/tmp/tc2001stub.ABCDEF","artifact":{...}}`.
Stderr prints the target host and `QA stub: no model, no human, no wake`.
Save the **artifact object**, not the enclosing readiness object, as `a.json` in
a private QA directory. The state path is required on every subsequent command.
Do not export a real `COURIER_HOME` into the stub process: a home outside the
state is refused. `--reply-text 'fixed text'` changes the reply prefix; the
incoming message id is always appended. `--decision approve|deny` selects the
fixed structured answer appended to replies to incoming messages with asks.
These canned answers are QA data, not owner approvals.

The other side uses its **own throwaway** Courier profile, initialized against
the same local node. The QA harness uses `fake-openkey.mjs` to create its owner
and install a grant through real `courier init --request --host <host>` followed
by `courier init --grant-file <private-grant-file>`. The stub never signs in to
an existing account. For manual QA, finish the separate setup measurement first;
then the three-artifact exchange is:

```sh
# QA side: set these to its already initialized private profile and home.
export HOME=/var/tmp/tc2001stub.PEER01/home
export COURIER_HOME=/var/tmp/tc2001stub.PEER01/peer
node dist/cli.js pair accept --file /var/tmp/tc2001stub.PEER01/a.json \
  > /var/tmp/tc2001stub.PEER01/b.json
# Stub control shell: unset the QA side's COURIER_HOME before calling the stub.
env -u COURIER_HOME node scripts/qa-stub-peer.mjs accept \
  --state /var/tmp/tc2001stub.ABCDEF --file /var/tmp/tc2001stub.PEER01/b.json \
  > /var/tmp/tc2001stub.PEER01/c.json
# QA side: install C to finish both sides.
node dist/cli.js pair accept --file /var/tmp/tc2001stub.PEER01/c.json
```

`accept` also reads an artifact from stdin when `--file` is omitted. It accepts
A, B or C through the real CLI; starting the stub emits A, so the normal route
above sends B into the stub and returns C. Pairing artifacts intentionally carry
peer delegation material; exchange them privately. No owner key, owner grant,
API token or SD-JWT is printed. Example paths are placeholders, not directories
to create by hand; allocate QA directories with
`mktemp -d -p /var/tmp tc2001stub.XXXXXX` and record each exact path.

## Matrix rows

These keys match the Courier matrix source. Count the QA side's owner steps;
the stub's scripted operations do not substitute for those steps.

| Data key | Exact cue/QA sequence | Measurer sees |
|---|---|---|
| `start-courier` | QA install and `courier init --paste` setup first, without a stub. Then start the stub and exchange A → B → C as above. | Setup approval/code/permit and peer choice; pairing is a separate prerequisite. |
| `follow-a-conversation` | `cue send-thread`; QA runs `courier inbox --json` and `courier read <threadId> --json`. | A real inbound thread with a fixed request; owner involvement only if it exceeds standing orders. |
| `reply` | After `cue send-thread`, QA runs `courier send qa-stub --thread <threadId> --intent answer --reply-to <messageId> --text 'Read and handled'`. | Stub notices the reply and sends exactly one fixed acknowledgement with its incoming id. |
| `check-with-you-before-going-on` | `cue ask --verb other --target qa:fixed-follow-up --summary 'Post a fixed QA follow-up'`; QA follows the real task/request/approval sequence below and replies; `cue wait-answer <askId>`. Optional `cue pause <threadId>` / `cue resume <threadId>` independently pauses/resumes stub replies. | ONE specific requestId/action for the QA owner's decision; approved answer yields a fixed resumed message, denial a fixed denied message. A transport pause is not an owner approval. |
| `send-a-new-request` | QA runs `courier send qa-stub --new 'QA request' --intent request --text 'Please acknowledge'`; optional `cue block` before sending, then `cue unblock`. | Exactly one fixed reply; while blocked no inbox reads or replies; after unblock queued messages are answered once. |

Every cue below includes the explicit state directory:

```sh
# Run stub controls with COURIER_HOME unset, or set to <state>/courier.
unset COURIER_HOME
node scripts/qa-stub-peer.mjs cue send-thread --state /var/tmp/tc2001stub.ABCDEF \
  --subject 'QA inbound thread' --text 'QA stub: please read and reply once.'
node scripts/qa-stub-peer.mjs cue ask --state /var/tmp/tc2001stub.ABCDEF \
  --verb other --target qa:fixed-follow-up --summary 'Post a fixed QA follow-up'
node scripts/qa-stub-peer.mjs cue wait-answer <askId> \
  --state /var/tmp/tc2001stub.ABCDEF --timeout 60
node scripts/qa-stub-peer.mjs cue block --state /var/tmp/tc2001stub.ABCDEF
node scripts/qa-stub-peer.mjs cue unblock --state /var/tmp/tc2001stub.ABCDEF
node scripts/qa-stub-peer.mjs cue pause <threadId> --state /var/tmp/tc2001stub.ABCDEF
node scripts/qa-stub-peer.mjs cue resume <threadId> --state /var/tmp/tc2001stub.ABCDEF
node scripts/qa-stub-peer.mjs cue revoke --state /var/tmp/tc2001stub.ABCDEF
node scripts/qa-stub-peer.mjs status --state /var/tmp/tc2001stub.ABCDEF
```

`send-thread` prints a thread/message id. `ask` prints those plus the unique
`askId`. Status is one JSON line with paired state, thread count, replies sent,
blocked state, paused threads, threads started, replies received, asks sent,
answers received, resumed actions, and unparseable answer count. Counters survive
an explicit kept-state restart. Cues are owner-only control files (0600),
processed serially with CLI operations. Normal messages are never commands.

`revoke` is optional and **not a matrix row**. On this base the real CLI drops
local peer state and prints its TC-721 expiry note. It does not immediately
remove the peer's node access. The stub does not claim otherwise.

## Owner decision bridge

The stub sends a real `ask`-intent Courier message with a short human title via
`--ask` (the current CLI assigns its metadata id `a1`). Its body explains the
request naturally, with a trailing fenced JSON envelope
`{type:'qa-stub-ask',askId,verb,target,summary}` for correlation.
`--verb merge` is refused because this script has no merge pins or merge action;
use `other` for the fixed QA follow-up. Other verbs must satisfy Courier's real
request validation; no privileged action is executed for any verb.

**The stub does not authenticate or observe the peer's private approval; it only
records the answer the peer agent sends back.** `courier request` asks the
caller's own owner. The QA agent therefore opens a real task and request on its
own profile, checks its own owner's decision with the real CLI, and sends the
answer. Neither a generic yes/no message nor a transport resume approves a
request. The stub never writes the peer's private request or approval paths.

```sh
# QA profile, in the ask's thread; save the taskId then requestId from stdout.
node dist/cli.js task new --peer qa-stub --thread <threadId> \
  --state working --ask a1
node dist/cli.js request <threadId> --peer qa-stub --task <taskId> \
  --verb other --target qa:fixed-follow-up \
  --summary 'Post a fixed QA follow-up' --why 'QA owner decision only'
# QA owner's view decides this ONE requestId; automated e2e uses only its fake owner.
node dist/cli.js watch --once --wake none --notify none --cwd <private-QA-directory>
node dist/cli.js approval <requestId> --verb other --target qa:fixed-follow-up
# On approved/consumed:
node dist/cli.js send qa-stub --thread <threadId> --intent answer \
  --reply-to <askMessageId> --text 'approve <askId>'
# On approval-denied (exit 1):
node dist/cli.js send qa-stub --thread <threadId> --intent answer \
  --reply-to <askMessageId> --text 'deny <askId>'
```

Both answer forms are accepted: plain text starting with `approve <askId>` or
`deny <askId>` (optional trailing words), or the complete JSON body
`{"type":"qa-stub-answer","askId":"<askId>","answer":"approve"}` (or
`deny`). The answer must be from the specific peer that received that ask, in its thread, with the
real `--reply-to` pointing at its ask message. Wrong ids, missing correlation,
repeated decisions, answers from another paired peer and other text are counted as unparseable; no question or
follow-up is posted for them. An accepted approval posts only
`QA stub: resumed action (fixed follow-up only).`; a denial posts only
`QA stub: denied.`. There is no merge/deploy/publish action behind the message.

## Fresh, returning and cleanup

```sh
# Default stop removes ONLY this exact state directory.
node scripts/qa-stub-peer.mjs stop --state /var/tmp/tc2001stub.ABCDEF
# For returning measurement instead: stop but retain the throwaway profile.
node scripts/qa-stub-peer.mjs stop --keep-state --state /var/tmp/tc2001stub.ABCDEF
node scripts/qa-stub-peer.mjs start --host http://127.0.0.1:8000 \
  --state /var/tmp/tc2001stub.ABCDEF
# Final cleanup of an explicitly stopped, kept stub:
node scripts/qa-stub-peer.mjs purge --state /var/tmp/tc2001stub.ABCDEF
```

Fresh means a new state/throwaway identity and another pair exchange. Returning
means a kept state, the same node and the same QA-side profile; no new pairing
artifact is emitted (`artifact:null`). Repeat the cue sequences to measure the
flows again. Kept files are 0600, directories 0700. They contain a **throwaway
Courier agent key and its owner grant**, never a real account's key; the fake
owner private key stays only in memory and is discarded after setup. Purge the
kept directory after measurement. Running or foreign/unmarked directories and
symlinks are refused. An explicit `start --state` must name a stopped, marked
stub, even when the directory is empty or contains only `created-paths`. Only
a fresh directory allocated by that `start` invocation may initialize without
a marker. Nothing cleans up a QA peer profile implicitly.

Start and purge acquire the same exclusive `lifecycle.lock` before reading the
marker. The running process holds its claim through shutdown; concurrent starts
or a competing purge fail with a clear lifecycle-lock error. The lock contains
the PID, Linux `/proc/<pid>/stat` start time and a unique start nonce. Control
commands check PID **and** start time, so a reused PID is refused. Lock release
requires the matching nonce; atomic-write temporary names include PID and nonce.
This lifecycle check requires Linux `/proc`. After an abrupt kill, start still
refuses the stale lock and prints the explicit purge command below.

Pending and seen deliveries are keyed by `(peer, thread, message)` tuples, so a
second peer cannot consume another peer's delivery identity by reusing its IDs.

### After a crash

Discard the crashed throwaway run with this exact-path command (replace the
example with its recorded state path):

```sh
env -u COURIER_HOME node scripts/qa-stub-peer.mjs purge \
  --state /var/tmp/tc2001stub.ABCDEF
```

Only purge can recover a stale lock. It requires the canonical, owner-only,
marked directory with no symlinks, a valid lock identity, and the same identity
in the marker. The holder must be provably absent or its PID must now have a
different `/proc` start time. Live holders, unreadable/garbled records and
ambiguous process inspection are refused. Purges serialize recovery, rename the
stale lock to a unique `.stale-<nonce>` file, acquire a fresh exclusive claim,
and re-check the marker before deleting only that directory. Success prints one
JSON line: `{"purged":true,"path":"/var/tmp/tc2001stub.ABCDEF","recovered":true}`.
Start a fresh stub and pair again; the crashed identity/pairing is discarded.


Exit 0 means success; exit 1 means invalid arguments/state, refused operation,
timeout or node failure. A CLI call has a 45-second deadline; a control command
has a 65-second deadline; answer waiting defaults to 60 seconds (maximum 600).
Do not automatically repeat failed sends: delivery may have succeeded before a
connection failed. Inspect the throwaway run and start fresh if needed.

## Safety evidence

- Before SDK imports/writes, the stub replaces the environment with explicit
  private HOME/COURIER_HOME/TMPDIR/cache/test-fence paths and PATH. Only its local
  host/CLI fence variables are then added; no model API key or notifier variable
  is inherited. Tests inject a fake API key and notifier and assert both absent
  from every child environment and fence record.
- A preload guard wraps child-process entry points. Only the same Node binary
  running this checkout's real Courier CLI is allowed; all other spawn/exec/fork
  paths throw before launching. The e2e checks the complete `safety.jsonl` trace.
  State allocation is in-process, with no bootstrap child.
- Fetch, HTTP(S), TLS and socket connects are fenced to the explicit loopback
  node origin/port. Redirects are refused. Network audit records are checked for
  the entire stub run. No OpenKey server, model provider, mailer or notifier is
  contacted; the fake OpenKey helper talks directly to the local node.
- The stub uses direct `courier inbox` polling, with no watcher or wake adapter.
  The QA-side approval watcher is explicitly `--wake none --notify none`.
- Unit tests deliberately mutate the reply-once, block, ask-id and approve-only
  guards in recorded scratch copies: each mutation fails its regression, while
  the untouched implementation passes. Tests never edit existing assertions.

| Guard | Scratch mutation | Failing regression | Restored result |
|---|---|---|---|
| Reply once | Remove the seen-message guard | Repeated inbox must send once | Green |
| Block | Remove the blocked guard | Blocked cycle must make zero inbox/send calls | Green |
| Ask id | Ignore the expected ask id | Wrong-id answer must not resume | Green |
| Approve only | Count denial as a resumed action | Deny must have zero resumed actions | Green |
| State marker | Ignore marker type/path | Foreign marker must be refused | Green |
| Kept state | Ignore running-state guard | Running state must not be reused/purged | Green |
| Intended peer | Remove answer peer equality | Another paired peer with matching IDs/reference cannot answer | Green |
| Delivery tuple | Collapse key to message ID | Colliding peer/thread deliveries still receive separate replies | Green |
| Lifecycle claim | Replace exclusive `wx` with `w` | A second claim must be refused | Green |
| Purge claim | Omit purge from lifecycle locking | Purge cannot enter a claimed startup window | Green |
| Process identity | Ignore process start time | A reused PID must be refused | Green |
| Explicit state | Accept an unmarked explicit directory | Empty/registry-only directories must be refused | Green |
| Dead holder | Treat a live PID/start-time as dead | A live holder cannot be purged | Green |
| Recovery scope | Remove exact state-path pattern check | A marked dead fixture outside the exact pattern remains untouched | Green |

Run the offline tests or the optional local-node proof from the repository root:

```sh
node --test packages/courier/scripts/qa-stub-peer.test.mjs
TC_REPLICATION_E2E_NODE_BIN=/absolute/path/to/tinycloud \
  node --test packages/courier/scripts/qa-stub-peer.test.mjs
```

The I0 Courier CI lane runs the offline tests. The node-replication e2e lane runs
all tests against its local node binary. Without that variable the real-node
case is explicitly skipped. The e2e prints redacted flow/safety result lines;
there are no model calls, real owner decisions or production-node operations.
