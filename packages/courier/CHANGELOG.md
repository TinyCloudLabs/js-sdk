# @tinycloud/courier

## 0.4.1-beta.1

### Patch Changes

- Updated dependencies [5e47629]
  - @tinycloud/share-envelope@1.4.1-beta.0
  - @tinycloud/node-sdk@3.8.1-beta.1
  - @tinycloud/sdk-core@3.8.1-beta.1

## 0.4.1-beta.0

### Patch Changes

- Updated dependencies [f1744fb]
  - @tinycloud/node-sdk@3.8.1-beta.0

## 0.4.0

### Minor Changes

- c6b78b2: Courier pairing now accepts artifacts from a different Courier agent key of the same owner, so two agents sharing one `did:pkh` pair like any two agents. Pairing still refuses the agent's own courier DID, and the peer delegation binding is unchanged. Tested with an isolated same-owner A→B→C exchange plus self-pair, key-substitution and different-owner regression checks.

  Details: TC-1248

### Patch Changes

- 406ec01: Add a one-prompt guided start with persisted chat discovery, explicit selection, and signed invitation links. Support same-owner agents, anyone holding the link, and named Courier keys or verified paired handles through a participating issuer's scoped KV pairing relay. Bind joins and durable winning claims to the intended session; keep existing manual pairing guards and restrict guided peer grants to one thread. Email recipient identifiers are refused rather than treated as verified names.

  Explicitly supplied empty invitation links, including positional links, are refused before chat discovery or creation; they cannot create or activate a fallback session.

  Details: TC-1543

- Updated dependencies [15080ed]
- Updated dependencies [32ed899]
- Updated dependencies [49f3665]
- Updated dependencies [20a872e]
- Updated dependencies [479205d]
- Updated dependencies [19048ec]
- Updated dependencies [92e4bd0]
- Updated dependencies [e740a6d]
- Updated dependencies [c541786]
- Updated dependencies [e424ba9]
- Updated dependencies [812a818]
- Updated dependencies [7b22f61]
- Updated dependencies [4a19c47]
- Updated dependencies [5d9d314]
- Updated dependencies [44c439a]
- Updated dependencies [2789240]
- Updated dependencies [f167805]
- Updated dependencies [9fb359a]
- Updated dependencies [9fb359a]
- Updated dependencies [812a818]
  - @tinycloud/node-sdk@3.8.0
  - @tinycloud/sdk-core@3.8.0
  - @tinycloud/share-envelope@1.4.0

## 0.4.0-beta.23

### Patch Changes

- @tinycloud/node-sdk@3.8.0-beta.23
- @tinycloud/sdk-core@3.8.0-beta.23

## 0.4.0-beta.22

### Patch Changes

- @tinycloud/node-sdk@3.8.0-beta.22
- @tinycloud/sdk-core@3.8.0-beta.22

## 0.4.0-beta.21

### Patch Changes

- Updated dependencies [9fb359a]
- Updated dependencies [9fb359a]
  - @tinycloud/sdk-core@3.8.0-beta.21
  - @tinycloud/node-sdk@3.8.0-beta.21

## 0.4.0-beta.20

### Patch Changes

- Updated dependencies [e424ba9]
  - @tinycloud/node-sdk@3.8.0-beta.20
  - @tinycloud/sdk-core@3.8.0-beta.20

## 0.4.0-beta.19

### Patch Changes

- Updated dependencies [19048ec]
  - @tinycloud/share-envelope@1.4.0-beta.2
  - @tinycloud/node-sdk@3.8.0-beta.19
  - @tinycloud/sdk-core@3.8.0-beta.19

## 0.4.0-beta.18

### Patch Changes

- @tinycloud/node-sdk@3.8.0-beta.18
- @tinycloud/sdk-core@3.8.0-beta.18

## 0.4.0-beta.17

### Patch Changes

- @tinycloud/node-sdk@3.8.0-beta.17
- @tinycloud/sdk-core@3.8.0-beta.17

## 0.4.0-beta.16

### Patch Changes

- 406ec01: Add a one-prompt guided start with persisted chat discovery, explicit selection, and signed invitation links. Support same-owner agents, anyone holding the link, and named Courier keys or verified paired handles through a participating issuer's scoped KV pairing relay. Bind joins and durable winning claims to the intended session; keep existing manual pairing guards and restrict guided peer grants to one thread. Email recipient identifiers are refused rather than treated as verified names.

  Explicitly supplied empty invitation links, including positional links, are refused before chat discovery or creation; they cannot create or activate a fallback session.

  Details: TC-1543

## 0.4.0-beta.15

### Minor Changes

- c6b78b2: Courier pairing now accepts artifacts from a different Courier agent key of the same owner, so two agents sharing one `did:pkh` pair like any two agents. Pairing still refuses the agent's own courier DID, and the peer delegation binding is unchanged. Tested with an isolated same-owner A→B→C exchange plus self-pair, key-substitution and different-owner regression checks.

  Details: TC-1248

## 0.3.3-beta.14

### Patch Changes

- Updated dependencies [812a818]
- Updated dependencies [812a818]
  - @tinycloud/node-sdk@3.8.0-beta.16
  - @tinycloud/sdk-core@3.8.0-beta.16

## 0.3.3-beta.13

### Patch Changes

- Updated dependencies [f167805]
  - @tinycloud/sdk-core@3.8.0-beta.15
  - @tinycloud/node-sdk@3.8.0-beta.15

## 0.3.3-beta.12

### Patch Changes

- Updated dependencies [49f3665]
- Updated dependencies [e740a6d]
  - @tinycloud/sdk-core@3.8.0-beta.14
  - @tinycloud/node-sdk@3.8.0-beta.14

## 0.3.3-beta.11

### Patch Changes

- Updated dependencies [32ed899]
  - @tinycloud/node-sdk@3.8.0-beta.13

## 0.3.3-beta.10

### Patch Changes

- Updated dependencies [5d9d314]
  - @tinycloud/node-sdk@3.8.0-beta.11

## 0.3.3-beta.9

### Patch Changes

- Updated dependencies [20a872e]
  - @tinycloud/node-sdk@3.8.0-beta.10

## 0.3.3-beta.8

### Patch Changes

- Updated dependencies [92e4bd0]
  - @tinycloud/node-sdk@3.8.0-beta.9
  - @tinycloud/sdk-core@3.8.0-beta.9

## 0.3.3-beta.7

### Patch Changes

- @tinycloud/node-sdk@3.8.0-beta.7

## 0.3.3-beta.6

### Patch Changes

- Updated dependencies [479205d]
  - @tinycloud/node-sdk@3.8.0-beta.6

## 0.3.3-beta.5

### Patch Changes

- Updated dependencies [44c439a]
  - @tinycloud/sdk-core@3.8.0-beta.5
  - @tinycloud/node-sdk@3.8.0-beta.5

## 0.3.3-beta.4

### Patch Changes

- Updated dependencies [c541786]
  - @tinycloud/sdk-core@3.8.0-beta.4
  - @tinycloud/node-sdk@3.8.0-beta.4

## 0.3.3-beta.3

### Patch Changes

- @tinycloud/sdk-core@3.8.0-beta.3
- @tinycloud/node-sdk@3.8.0-beta.3

## 0.3.3-beta.2

### Patch Changes

- Updated dependencies [4a19c47]
  - @tinycloud/sdk-core@3.8.0-beta.2
  - @tinycloud/node-sdk@3.8.0-beta.2

## 0.3.3-beta.1

### Patch Changes

- Updated dependencies [2789240]
  - @tinycloud/sdk-core@3.8.0-beta.1
  - @tinycloud/node-sdk@3.8.0-beta.1

## 0.3.3-beta.0

### Patch Changes

- Updated dependencies [15080ed]
  - @tinycloud/node-sdk@3.8.0-beta.0

## 0.3.2

### Patch Changes

- Updated dependencies [c142537]
- Updated dependencies [279c8e9]
- Updated dependencies [71fa087]
- Updated dependencies [147bb78]
  - @tinycloud/node-sdk@3.7.0
  - @tinycloud/sdk-core@3.7.0

## 0.3.2-beta.4

### Patch Changes

- Updated dependencies [c142537]
  - @tinycloud/node-sdk@3.7.0-beta.4
  - @tinycloud/sdk-core@3.7.0-beta.4

## 0.3.2-beta.3

### Patch Changes

- Updated dependencies [279c8e9]
  - @tinycloud/node-sdk@3.7.0-beta.3
  - @tinycloud/sdk-core@3.7.0-beta.3

## 0.3.2-beta.2

### Patch Changes

- Updated dependencies [147bb78]
  - @tinycloud/node-sdk@3.7.0-beta.2
  - @tinycloud/sdk-core@3.7.0-beta.2

## 0.3.2-beta.1

### Patch Changes

- Updated dependencies [71fa087]
  - @tinycloud/node-sdk@3.7.0-beta.1
  - @tinycloud/sdk-core@3.7.0-beta.1

## 0.3.2-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.6.2-beta.0

## 0.3.1

### Patch Changes

- 8acd73d: The courier test suite now runs every test file under a temporary home, and with `COURIER_TEST=1` the profile directory resolver refuses a home outside `COURIER_TEST_HOME` (`test-home-escape`). Without `COURIER_TEST=1` behaviour is unchanged.

  Details: TC-712

- Updated dependencies [271155a]
- Updated dependencies [09b7dc0]
  - @tinycloud/node-sdk@3.6.1
  - @tinycloud/sdk-core@3.6.1

## 0.3.1-beta.2

### Patch Changes

- 8acd73d: The courier test suite now runs every test file under a temporary home, and with `COURIER_TEST=1` the profile directory resolver refuses a home outside `COURIER_TEST_HOME` (`test-home-escape`). Without `COURIER_TEST=1` behaviour is unchanged.

  Details: TC-712

## 0.3.1-beta.1

### Patch Changes

- Updated dependencies [09b7dc0]
  - @tinycloud/node-sdk@3.6.1-beta.1

## 0.3.1-beta.0

### Patch Changes

- Updated dependencies [271155a]
  - @tinycloud/node-sdk@3.6.1-beta.0

## 0.3.0

### Minor Changes

- c0acb86: Adds `courier credential acquire --email <addr>` and `courier credential show --email <addr>`. `acquire` requests an email verification code. Run it again with `--code-stdin` and enter the code on stdin to store the verified credential under `COURIER_HOME/credentials/` (owner-only). `show` prints `email`, `credentialId`, `issuedAt`, `expiresAt`, and `status`, never the credential itself.

  Details: TC-712

- 7bd4ae6: `@tinycloud/node-sdk/credentials` adds `verifyStoredEmailProof`, which re-verifies a stored email-proof credential offline: descriptor digest pin, envelope rebuild, pinned issuer keys, status check, and holder match. `@tinycloud/node-sdk/credential-pending-store` exports `ensureSecureDir` and `checkSecureDir`. The credentials directory must be a real directory with owner-only mode; a symlink or a file is refused, and a pre-existing directory with loose permissions is refused rather than chmodded. A pending request expires at the earlier of the witness expiry and 15 minutes after creation.

  `courier credential acquire` writes one JSON document to stdout per call (pretty printed, nothing else on stdout; hints go to stderr): `status: "code-sent"` with `codeExpiresAt` on the first call, then `status: "acquired"` with `issuedAt` and `expiresAt` on the second. The verification code must be entered within 5 minutes. `courier credential show` writes one JSON document with `address`, `credentialId`, `issuedAt`, `expiresAt`, and `status`, never the credential. Stored credentials are re-verified offline on every read before any other rule applies; a record that fails is refused with `credential-record-invalid` and kept, and nothing is deleted on the strength of unverified stored fields. A credential that passed verification is dropped when less than 60 seconds of its own expiry remain or once older than the 3600-second maximum age. Courier refuses to run when both `HOME` and `COURIER_HOME` are unset. `courier --version` prints the package version.

  Details: TC-1757

### Patch Changes

- 7bd4ae6: `courier credential show` no longer deletes a stored credential that fails offline re-verification. The record is refused with `credential-record-invalid` and kept under `COURIER_HOME/credentials/` for inspection. Lifecycle drops are unchanged: a credential within 60 seconds of its own expiry, or older than the 3600-second maximum age, is still deleted.

  `@tinycloud/node-sdk/credentials` also exports the `StoredEmailProofInput` type.

  `@tinycloud/web-sdk/credentials` adds `verifyStoredEmailProof` and the `StoredEmailProofInput` and `StoredEmailProofRecord` types, so headless clients can re-verify a stored email-proof credential offline without importing `@tinycloud/node-sdk` directly.

  Details: TC-712

- Updated dependencies [e600a1a]
- Updated dependencies [0c09d7b]
- Updated dependencies [1f831e3]
- Updated dependencies [7bd4ae6]
- Updated dependencies [7bd4ae6]
- Updated dependencies [e32bc41]
- Updated dependencies [c0acb86]
  - @tinycloud/node-sdk@3.6.0
  - @tinycloud/sdk-core@3.6.0

## 0.3.0-beta.7

### Patch Changes

- Updated dependencies [1f831e3]
  - @tinycloud/sdk-core@3.6.0-beta.8
  - @tinycloud/node-sdk@3.6.0-beta.8

## 0.3.0-beta.6

### Minor Changes

- 7bd4ae6: `@tinycloud/node-sdk/credentials` adds `verifyStoredEmailProof`, which re-verifies a stored email-proof credential offline: descriptor digest pin, envelope rebuild, pinned issuer keys, status check, and holder match. `@tinycloud/node-sdk/credential-pending-store` exports `ensureSecureDir` and `checkSecureDir`. The credentials directory must be a real directory with owner-only mode; a symlink or a file is refused, and a pre-existing directory with loose permissions is refused rather than chmodded. A pending request expires at the earlier of the witness expiry and 15 minutes after creation.

  `courier credential acquire` writes one JSON document to stdout per call (pretty printed, nothing else on stdout; hints go to stderr): `status: "code-sent"` with `codeExpiresAt` on the first call, then `status: "acquired"` with `issuedAt` and `expiresAt` on the second. The verification code must be entered within 5 minutes. `courier credential show` writes one JSON document with `address`, `credentialId`, `issuedAt`, `expiresAt`, and `status`, never the credential. Stored credentials are re-verified offline on every read before any other rule applies; a record that fails is refused with `credential-record-invalid` and kept, and nothing is deleted on the strength of unverified stored fields. A credential that passed verification is dropped when less than 60 seconds of its own expiry remain or once older than the 3600-second maximum age. Courier refuses to run when both `HOME` and `COURIER_HOME` are unset. `courier --version` prints the package version.

  Details: TC-1757

### Patch Changes

- 7bd4ae6: `courier credential show` no longer deletes a stored credential that fails offline re-verification. The record is refused with `credential-record-invalid` and kept under `COURIER_HOME/credentials/` for inspection. Lifecycle drops are unchanged: a credential within 60 seconds of its own expiry, or older than the 3600-second maximum age, is still deleted.

  `@tinycloud/node-sdk/credentials` also exports the `StoredEmailProofInput` type.

  `@tinycloud/web-sdk/credentials` adds `verifyStoredEmailProof` and the `StoredEmailProofInput` and `StoredEmailProofRecord` types, so headless clients can re-verify a stored email-proof credential offline without importing `@tinycloud/node-sdk` directly.

  Details: TC-712

- Updated dependencies [7bd4ae6]
- Updated dependencies [7bd4ae6]
  - @tinycloud/node-sdk@3.6.0-beta.7

## 0.3.0-beta.5

### Patch Changes

- Updated dependencies [e600a1a]
  - @tinycloud/node-sdk@3.6.0-beta.6

## 0.3.0-beta.4

### Minor Changes

- c0acb86: Adds `courier credential acquire --email <addr>` and `courier credential show --email <addr>`. `acquire` requests an email verification code. Run it again with `--code-stdin` and enter the code on stdin to store the verified credential under `COURIER_HOME/credentials/` (owner-only). `show` prints `email`, `credentialId`, `issuedAt`, `expiresAt`, and `status`, never the credential itself.

  Details: TC-712

### Patch Changes

- Updated dependencies [c0acb86]
  - @tinycloud/node-sdk@3.6.0-beta.5

## 0.2.4-beta.3

### Patch Changes

- Updated dependencies [e32bc41]
  - @tinycloud/node-sdk@3.6.0-beta.4

## 0.2.4-beta.2

### Patch Changes

- @tinycloud/node-sdk@3.6.0-beta.3

## 0.2.4-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.6.0-beta.2

## 0.2.4-beta.0

### Patch Changes

- Updated dependencies [0c09d7b]
  - @tinycloud/node-sdk@3.6.0-beta.0

## 0.2.3

### Patch Changes

- Updated dependencies [d60f81d]
- Updated dependencies [7b92156]
- Updated dependencies [7b92156]
  - @tinycloud/node-sdk@3.5.0

## 0.2.3-beta.1

### Patch Changes

- Updated dependencies [7b92156]
- Updated dependencies [7b92156]
  - @tinycloud/node-sdk@3.5.0-beta.1

## 0.2.3-beta.0

### Patch Changes

- Updated dependencies [d60f81d]
  - @tinycloud/node-sdk@3.5.0-beta.0

## 0.2.2

### Patch Changes

- @tinycloud/node-sdk@3.4.0

## 0.2.2-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.3.2-beta.1

## 0.2.2-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.3.2-beta.0

## 0.2.1

### Patch Changes

- @tinycloud/node-sdk@3.3.1

## 0.2.1-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.3.1-beta.0

## 0.2.0

### Minor Changes

- f81a22c: `courier approval <requestId>`: verifies the owner's decision before a gated action. The approval in `me/approvals/` must name the request, carry the SHA-256 of the request's canonical JSON (`canonicalJson` and `requestHash` are exported), say `approved`, be under 24 hours old and inside the request's lifetime, and match your `--verb` and `--target`; it is consumed once (create-only marker under `me/consumed/`). `courier watch` now wakes the thread's agent as soon as a new approval appears; the wake prompt tells the agent to run `courier approval` first.

  `courier request` now requires `--verb` (merge, deploy, publish, spend, other), `--target` (canonical per verb) and `--summary` (one line, at most 200 characters); they are stored in the request and covered by its hash, so older free-text-only requests can no longer be approved. `--action` is optional display text.

  One text rule set applies when `courier request` writes, when `courier approval` reads and in the `/courier` view: a frozen Unicode 15.0.0 allow-list (Lu/Ll/Lt/Lo/Nd minus Default*Ignorable), NFC, ASCII punctuation only (summary `. , : ; - * / # ( ) ? !`and U+0027; free multiline text all printable ASCII punctuation plus LF), plain U+0020 space only, caps (target and summary 200, action/reason/risk 2000),`target`printable ASCII in its per-verb canonical shape; violations are refused, never repaired.`canonicalJson`/`requestHash`throw on non-finite numbers and nesting deeper than 64.`test/vectors/request-fields.json`and the exhaustive`text-verdicts.json`hold the shared contract;`src/text-ranges.ts` is the generated table. Previously accepted emoji, smart apostrophes and all remaining combining marks are now refused. Watcher shutdown permanently latches runner cancellation so adapter follow-on commands cannot start after SIGINT/SIGTERM.

- ecaf34b: Wake budget, pause and notifications for `courier watch`: at most `--wake-budget` (default 12) message wakes per side per thread per UTC day, then the thread pauses: a marker under `me/state/paused/`, an `inform` "thread paused" to the peer (never wakes it), and a notification to your human through `--notify none|osascript|exec` (queued in state; at most three notification attempts, every success/failure counts toward the 10/hour/peer and global caps). A paused thread still delivers and mirrors but never wakes; the peer's watcher notifies its human when it sees the inform. New `courier pause <peer> <thread>` and `courier resume <peer> <thread>` (the budget starts over). Approval wakes are never counted or blocked.

  Count wake attempts (including failures), cap and deduplicate fixed-text notices with bounded persisted retries, and retain a bounded backlog through pause/resume. Notifications use local logs, osascript or an operator exec command only; no notification starts or messages an agent.

  Track pause/resume transitions in fixed records for locally known threads, ignore notice ULIDs that are not newer than the stored one or are more than ten minutes ahead of the local clock, keep inform ids stable through retries, and persist separate message/approval backoff from attempt completion. Keep two fixed pending episode slots per known thread, with separate retries and a bounded count for additional pauses. Reserve up to three of the global hourly attempts per locally paired peer.

  In notify-only mode, coalesce messages and decisions into two fixed slots per locally paired peer, with separate retries, counts and latest thread ULIDs. Admit and dispatch eligible notifications in peer round-robin order while retaining deferred retry metadata and arrivals during dispatch.

- db4781a: `courier guard`: a Claude Code PreToolUse hook that refuses direct merge, deploy, publish, pushes, credential-access and human-only Courier commands. It inspects quoting, wrappers, chains, subshells and nested shells. Approved PR merges use the fixed-argv `courier run-approved <requestId>` broker, which consumes the approval before executing. `courier watch --wake claude` installs guard settings and gives the agent its Courier-only profile snapshot.

  The courier grant now includes `me/consumed/` (get, put, list; no del) and approvals are marked used there instead of under `me/state/`, so the courier key cannot un-consume an approval. Existing grants are refused with `grant-incomplete` until `courier init` renews them (one passkey approval). The used check reads from the network every time and fails closed on anything but a key-level 404.

  `courier watch --wake paseo` now installs the same guard in `<cwd>/.claude/settings.local.json` (merged with what is there), runs the hook once on a call no approval can unlock and requires a refusal, and wakes nothing otherwise. It only messages Paseo agents labelled `courier-guard=1` that run Claude in the guarded directory, deletes an agent Paseo started elsewhere, and drops `PASEO_AGENT_*`/`PASEO_WORKSPACE_ID` from its environment so `--cwd` is honoured. Non-Claude `--paseo-provider` values are refused. Named agent CLI commands, recognized package entrypoints and unknown MCP tools are refused.

  `courier watch --wake exec` installs no guard, so it now needs `--exec <cmd> --unguarded` (also with `--install-launchd|--install-systemd`); without the flag the watcher refuses, wakes nothing and names the flag. Every exec wake prints "this wake is not approval-guarded" to stderr and adds it to `COURIER_PROMPT`. `--unguarded` is refused with the `claude`, `paseo` and `none` adapters, which are always guarded or wake nobody. Use `claude` or `paseo` for guarded agent sessions.

  The guard's first rule is now fail-closed: a command with run-time expansion or indirection syntax (`{a,b}`, `$…`, backticks, `eval`, `source`, `alias`, here-strings, `xargs`, `find -exec`, `env`/`command`/`sudo` prefixes, `| sh`, …) that also names a gated tool or verb is refused ("expansion syntax with a gated tool name"); plain-word commands are read as before. README, `--help` and the skill document refused commands and the broker invocation.

  Woken `claude` and `exec` runs get an environment allowlist and a separate HOME. `--env-pass NAME` adds an explicitly selected variable. The Paseo adapter blanks known credential names and credential-looking watcher variables. Guard settings refuse Read access to credential files.

  `courier pause`, `courier resume` and `courier watch` (also as `tc courier …`) and `courier approval` without `--peek` are refused for a woken agent even with an approval, like `courier pair|revoke|init`: the wake budget is the reply loop's breaker, so an agent must not lift its own pause or start a watcher.

  Details: TC-1634

- f7e95e4: Add `courier intake`: reads the mirror of each paired peer's messages from your self-space KV and writes one JSON record per message into a queue directory for a local reader, with cheap text checks and flags. Peers default to 100 inbound messages per hour; `peers.json` can lower that per peer. An invalid `peers.json` entry refuses the whole file: startup stops, and a running reader keeps its last good map. Queue text is capped at 16 KiB. Each cycle reads at most 200 mirror messages per peer, from a cyclic cursor kept in the state file; messages more than 7 days old by message time are not fetched. Messages over the per-peer cap are kept in an overflow directory until they are 7 days old, capped at 200 files and 1 MiB per peer, oldest dropped first. One intake process runs per state directory: a live lock holder refuses a second start, a dead holder's lock is broken, and an unreadable lock refuses. To skip existing history, run `courier intake --init-from-now` before the first run.
- c0d4f70: `courier outbox add` publishes each item through a same-directory `.tmp-` file (fsynced, then hard-linked into place), so the sender never sees a partial `<itemId>.json`. Item files and ledger entries are mode 0600 (were 0644), and peer outbox directories are created setgid, mode 2750 (were 0755). `outbox add` writes canonical bytes (`canonicalJson(item)` plus a newline) and the sender accepts only those bytes.
- c0d4f70: The outbox sender (`courier outbox serve`) now refuses to send unless the item is approved and unchanged:
  - Each send is bound to an owner-only approval ledger at `<outbox>/approved/<itemId>` (mode 0600), created by `outbox add` before the item. A missing ledger is `refused:not-approved`. Its digest must match the item bytes read in the same open snapshot, or the reply is `refused:hash-mismatch`.
  - Items must be the exact canonical bytes written by `outbox add`: no leading whitespace or byte-order mark, no invalid UTF-8, no pretty-printing, duplicate keys, or missing trailing newline (`refused:bad-item`). Items must be owned by the sender uid and mode 0600 (`refused:unsafe-item`).
  - A request is one frame of at most 64 bytes, `{"v":1,"itemId":"<ULID>"}` followed by a newline, validated before JSON parsing. The frame ends at its first newline. Bytes after that newline that arrive before the request is served refuse with `refused:bad-request` and zero sends. A connection that sends bytes but no complete frame within 5 seconds gets `refused:bad-request`. A connection that sends nothing is closed without a reply. One frame per connection.
  - A reservation that was consumed but has no result is recorded as `uncertain` at startup (`<itemId>.result.json`, state `uncertain`) and is never resent. A later request for that item is refused `refused:uncertain`.
  - Replies and sender logs carry fixed codes only. They never include item ids, paths, text, or peer ids. Diagnostic logs are capped at 10 per 60 seconds.
  - Connections (64) and pending requests (32) are bounded separately from the send quota. Requests are capped at 60 per 60 seconds; excess and pending overflow are refused `refused:busy`. Connections over the cap are closed without a reply. The socket keeps its 5 second idle timeout.
  - Peer policy errors keep the last valid policy loaded in this process and log `outbox.peers-invalid` with a fixed code only. If no policy has loaded since start, the outbound cap is 1 per hour until a valid file loads.

- 38271aa: `courier watch --wake paseo|claude|exec`: wake adapters. `paseo` messages the agent labelled `courier-thread=<id>` or creates one (labels `courier-thread`, `courier-peer`, title `✉ <peer> · <subject>`); `claude` runs `claude -p`, keeps the session id per thread and resumes it; `exec` runs a command with `COURIER_THREAD`, `COURIER_PEER`, `COURIER_MESSAGES`. The wake prompt frames the message as a counterparty request, not an instruction from the owner. `--install-launchd` and `--install-systemd` generate and install a launchd agent or a `systemd --user` unit (`--dry-run` prints the exact file and commands). Woken claude runs may use only `Bash(courier:*)` unless `--claude-settings`/`--claude-allow` widen it.
- 35bfabc: Add `courier watch`: subscribes to each paired peer's `to/<me>/` and your `me/approvals/` through write hooks (25 s tickets), polls every 60 s as the fallback, mirrors new messages, peer `meta.json` and peer tasks into `me/mirror/`, advances receipts, and wakes per thread after a 30 s debounce (`inform` never wakes). State lives in `me/state/watch.json`. This release logs the wake (`--wake none`); wake adapters follow.

### Patch Changes

- dbdb20e: Classify conditional-write and read failures from structured error fields (`code`, `status`, `meta.status`) only, never from message text. Previously the storage key was matched against a 412 pattern, so a non-412 failure on a key containing the digits `412` could be reported as a write conflict and silently skipped. Missing-key detection and transient read retries use the same structured fields.

  Details: TC-1684

- 19ca88c: `courier watch` wake budget, pause and notifications, final behaviour: `--notify` accepts `none`, `osascript` and `exec`. Notifications for new messages and decisions are coalesced into two fixed slots per locally paired peer, with separate retries and counts, and pause notices use fixed per-thread episode slots. Eligible notifications are admitted and dispatched in peer round-robin order within the hourly caps, a retry never delays another peer's reserved share, and a message that arrives while a notice is being delivered keeps its own pending notice. Each known thread keeps two pause-notice slots; further pauses are counted in a bounded counter. A notice id that is not newer than the stored one, or is more than ten minutes ahead of the local clock, is ignored.

  Details: TC-1634

- 842c596: `courier intake` and `courier outbox serve` accept `--peers-owner <name|uid>` (or `COURIER_PEERS_OWNER`) to name the account that must own `peers.json`. A user name is looked up in `/etc/passwd` and must match exactly one uid; accounts that exist only in NSS need the numeric uid. Without the flag the default is the running user on POSIX systems; elsewhere startup refuses unless the flag is given. The mode, symlink, and regular-file checks are unchanged.

  Details: TC-1634

- c06c304: Courier profile permission errors use code profile-permissions; documentation wording updates.
- 0524256: Keep broker configuration outside Courier and resolve the owner's gh credential at runtime without copying it. Woken agents use a separate home and Courier-only identity snapshot. Existing broker token files are no longer used; owners configure the broker again after signing in with gh.

  Refuse protected-root traversal, gated executable aliases/copies, local network destinations and additional GitHub, registry and credential-access commands.

  Require registered executable identities for tool allowances, including Courier entrypoints and wrappers. Unregistered executables and package launchers fail closed. Protect registered tools from agent edits and preserve the installed census across automatic refreshes; owners refresh it after tool upgrades.

  Inspect interpreter script and preload files independently of their extension, and classify agent and gated-tool package entrypoints by their package manifest. Require the installed executable census and use its git identity for guard probes.

  Details: TC-1634

- 030fdf4: TC-712: refuse direct gated commands from woken agents and execute approved PR merges through a fixed-argv, single-use broker. Protect guard settings, dependencies and credential paths. Existing hook allow-once workflows must use `courier run-approved <requestId>` instead; publish, deploy and direct pushes require the owner.
- 2f3978c: Bind merge approval requests to a head commit and case-sensitive base branch (TC-712). Merge requests now require `--head-sha` and `--base`; older unpinned merge requests must be re-requested and approved again. Other verbs reject these fields. Approval verification returns both pins and can require exact matches for the broker.
- Updated dependencies [2aa917e]
- Updated dependencies [b6d0b9f]
- Updated dependencies [d2ad845]
- Updated dependencies [29440be]
- Updated dependencies [a553392]
- Updated dependencies [86815bd]
- Updated dependencies [e7f709d]
- Updated dependencies [94566db]
- Updated dependencies [38980b0]
- Updated dependencies [41e5fca]
- Updated dependencies [a7cdfe0]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [87a137e]
- Updated dependencies [ef9653b]
- Updated dependencies [370a8e4]
- Updated dependencies [ef49c14]
- Updated dependencies [cce8b26]
- Updated dependencies [0c4c6b2]
- Updated dependencies [e99a127]
- Updated dependencies [f97d73d]
- Updated dependencies [18b6c9f]
- Updated dependencies [2292db7]
  - @tinycloud/node-sdk@3.3.0

## 0.2.0-beta.47

### Patch Changes

- Updated dependencies [ef49c14]
  - @tinycloud/node-sdk@3.3.0-beta.39

## 0.2.0-beta.46

### Patch Changes

- 842c596: `courier intake` and `courier outbox serve` accept `--peers-owner <name|uid>` (or `COURIER_PEERS_OWNER`) to name the account that must own `peers.json`. A user name is looked up in `/etc/passwd` and must match exactly one uid; accounts that exist only in NSS need the numeric uid. Without the flag the default is the running user on POSIX systems; elsewhere startup refuses unless the flag is given. The mode, symlink, and regular-file checks are unchanged.

  Details: TC-1634

## 0.2.0-beta.45

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.38

## 0.2.0-beta.44

### Minor Changes

- c0d4f70: `courier outbox add` publishes each item through a same-directory `.tmp-` file (fsynced, then hard-linked into place), so the sender never sees a partial `<itemId>.json`. Item files and ledger entries are mode 0600 (were 0644), and peer outbox directories are created setgid, mode 2750 (were 0755). `outbox add` writes canonical bytes (`canonicalJson(item)` plus a newline) and the sender accepts only those bytes.
- c0d4f70: The outbox sender (`courier outbox serve`) now refuses to send unless the item is approved and unchanged:
  - Each send is bound to an owner-only approval ledger at `<outbox>/approved/<itemId>` (mode 0600), created by `outbox add` before the item. A missing ledger is `refused:not-approved`. Its digest must match the item bytes read in the same open snapshot, or the reply is `refused:hash-mismatch`.
  - Items must be the exact canonical bytes written by `outbox add`: no leading whitespace or byte-order mark, no invalid UTF-8, no pretty-printing, duplicate keys, or missing trailing newline (`refused:bad-item`). Items must be owned by the sender uid and mode 0600 (`refused:unsafe-item`).
  - A request is one frame of at most 64 bytes, `{"v":1,"itemId":"<ULID>"}` followed by a newline, validated before JSON parsing. The frame ends at its first newline. Bytes after that newline that arrive before the request is served refuse with `refused:bad-request` and zero sends. A connection that sends bytes but no complete frame within 5 seconds gets `refused:bad-request`. A connection that sends nothing is closed without a reply. One frame per connection.
  - A reservation that was consumed but has no result is recorded as `uncertain` at startup (`<itemId>.result.json`, state `uncertain`) and is never resent. A later request for that item is refused `refused:uncertain`.
  - Replies and sender logs carry fixed codes only. They never include item ids, paths, text, or peer ids. Diagnostic logs are capped at 10 per 60 seconds.
  - Connections (64) and pending requests (32) are bounded separately from the send quota. Requests are capped at 60 per 60 seconds; excess and pending overflow are refused `refused:busy`. Connections over the cap are closed without a reply. The socket keeps its 5 second idle timeout.
  - Peer policy errors keep the last valid policy loaded in this process and log `outbox.peers-invalid` with a fixed code only. If no policy has loaded since start, the outbound cap is 1 per hour until a valid file loads.

## 0.2.0-beta.43

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.37

## 0.2.0-beta.42

### Minor Changes

- f7e95e4: Add `courier intake`: reads the mirror of each paired peer's messages from your self-space KV and writes one JSON record per message into a queue directory for a local reader, with cheap text checks and flags. Peers default to 100 inbound messages per hour; `peers.json` can lower that per peer. An invalid `peers.json` entry refuses the whole file: startup stops, and a running reader keeps its last good map. Queue text is capped at 16 KiB. Each cycle reads at most 200 mirror messages per peer, from a cyclic cursor kept in the state file; messages more than 7 days old by message time are not fetched. Messages over the per-peer cap are kept in an overflow directory until they are 7 days old, capped at 200 files and 1 MiB per peer, oldest dropped first. One intake process runs per state directory: a live lock holder refuses a second start, a dead holder's lock is broken, and an unreadable lock refuses. To skip existing history, run `courier intake --init-from-now` before the first run.

## 0.2.0-beta.41

### Patch Changes

- dbdb20e: Classify conditional-write and read failures from structured error fields (`code`, `status`, `meta.status`) only, never from message text. Previously the storage key was matched against a 412 pattern, so a non-412 failure on a key containing the digits `412` could be reported as a write conflict and silently skipped. Missing-key detection and transient read retries use the same structured fields.

  Details: TC-1684

## 0.2.0-beta.40

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.36

## 0.2.0-beta.39

### Patch Changes

- 19ca88c: `courier watch` wake budget, pause and notifications, final behaviour: `--notify` accepts `none`, `osascript` and `exec`. Notifications for new messages and decisions are coalesced into two fixed slots per locally paired peer, with separate retries and counts, and pause notices use fixed per-thread episode slots. Eligible notifications are admitted and dispatched in peer round-robin order within the hourly caps, a retry never delays another peer's reserved share, and a message that arrives while a notice is being delivered keeps its own pending notice. Each known thread keeps two pause-notice slots; further pauses are counted in a bounded counter. A notice id that is not newer than the stored one, or is more than ten minutes ahead of the local clock, is ignored.

  Details: TC-1634

## 0.2.0-beta.38

### Minor Changes

- ecaf34b: Wake budget, pause and notifications for `courier watch`: at most `--wake-budget` (default 12) message wakes per side per thread per UTC day, then the thread pauses: a marker under `me/state/paused/`, an `inform` "thread paused" to the peer (never wakes it), and a notification to your human through `--notify paseo|osascript|exec` (queued in state and retried). A paused thread still delivers and mirrors but never wakes; the peer's watcher notifies its human when it sees the inform. New `courier pause <peer> <thread>` and `courier resume <peer> <thread>` (the budget starts over). Approval wakes are never counted or blocked.

  Count wake attempts (including failures), cap and deduplicate fixed-text notices with bounded persisted retries, and retain a bounded backlog through pause/resume. Notifications use local logs, osascript or an operator exec command only; no notification starts or messages an agent.

- db4781a: `courier guard`: a Claude Code PreToolUse hook that refuses direct merge, deploy, publish, pushes, credential-access and human-only Courier commands. It inspects quoting, wrappers, chains, subshells and nested shells. Approved PR merges use the fixed-argv `courier run-approved <requestId>` broker, which consumes the approval before executing. `courier watch --wake claude` installs guard settings and gives the agent its Courier-only profile snapshot.

  The courier grant now includes `me/consumed/` (get, put, list; no del) and approvals are marked used there instead of under `me/state/`, so the courier key cannot un-consume an approval. Existing grants are refused with `grant-incomplete` until `courier init` renews them (one passkey approval). The used check reads from the network every time and fails closed on anything but a key-level 404.

  `courier watch --wake paseo` now installs the same guard in `<cwd>/.claude/settings.local.json` (merged with what is there), runs the hook once on a call no approval can unlock and requires a refusal, and wakes nothing otherwise. It only messages Paseo agents labelled `courier-guard=1` that run Claude in the guarded directory, deletes an agent Paseo started elsewhere, and drops `PASEO_AGENT_*`/`PASEO_WORKSPACE_ID` from its environment so `--cwd` is honoured. Non-Claude `--paseo-provider` values are refused. Named agent CLI commands, recognized package entrypoints and unknown MCP tools are refused.

  `courier watch --wake exec` installs no guard, so it now needs `--exec <cmd> --unguarded` (also with `--install-launchd|--install-systemd`); without the flag the watcher refuses, wakes nothing and names the flag. Every exec wake prints "this wake is not approval-guarded" to stderr and adds it to `COURIER_PROMPT`. `--unguarded` is refused with the `claude`, `paseo` and `none` adapters, which are always guarded or wake nobody. Use `claude` or `paseo` for guarded agent sessions.

  The guard's first rule is now fail-closed: a command with run-time expansion or indirection syntax (`{a,b}`, `$…`, backticks, `eval`, `source`, `alias`, here-strings, `xargs`, `find -exec`, `env`/`command`/`sudo` prefixes, `| sh`, …) that also names a gated tool or verb is refused ("expansion syntax with a gated tool name"); plain-word commands are read as before. README, `--help` and the skill document refused commands and the broker invocation.

  Woken `claude` and `exec` runs get an environment allowlist and a separate HOME. `--env-pass NAME` adds an explicitly selected variable. The Paseo adapter blanks known credential names and credential-looking watcher variables. Guard settings refuse Read access to credential files.

  `courier pause`, `courier resume` and `courier watch` (also as `tc courier …`) and `courier approval` without `--peek` are refused for a woken agent even with an approval, like `courier pair|revoke|init`: the wake budget is the reply loop's breaker, so an agent must not lift its own pause or start a watcher.

  Details: TC-1634

### Patch Changes

- 0524256: Keep broker configuration outside Courier and resolve the owner's gh credential at runtime without copying it. Woken agents use a separate home and Courier-only identity snapshot. Existing broker token files are no longer used; owners configure the broker again after signing in with gh.

  Refuse protected-root traversal, gated executable aliases/copies, local network destinations and additional GitHub, registry and credential-access commands.

  Require registered executable identities for tool allowances, including Courier entrypoints and wrappers. Unregistered executables and package launchers fail closed. Protect registered tools from agent edits and preserve the installed census across automatic refreshes; owners refresh it after tool upgrades.

  Inspect interpreter script and preload files independently of their extension, and classify agent and gated-tool package entrypoints by their package manifest. Require the installed executable census and use its git identity for guard probes.

  Details: TC-1634

- 030fdf4: TC-712: refuse direct gated commands from woken agents and execute approved PR merges through a fixed-argv, single-use broker. Protect guard settings, dependencies and credential paths. Existing hook allow-once workflows must use `courier run-approved <requestId>` instead; publish, deploy and direct pushes require the owner.

## 0.2.0-beta.37

### Patch Changes

- c06c304: Courier profile permission errors use code profile-permissions; documentation wording updates.

## 0.2.0-beta.36

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.35

## 0.2.0-beta.35

### Patch Changes

- 2f3978c: Bind merge approval requests to a head commit and case-sensitive base branch (TC-712). Merge requests now require `--head-sha` and `--base`; older unpinned merge requests must be re-requested and approved again. Other verbs reject these fields. Approval verification returns both pins and can require exact matches for the broker.

## 0.2.0-beta.34

### Minor Changes

- f81a22c: `courier approval <requestId>`: verifies the owner's decision before a gated action. The approval in `me/approvals/` must name the request, carry the SHA-256 of the request's canonical JSON (`canonicalJson` and `requestHash` are exported), say `approved`, be under 24 hours old and inside the request's lifetime, and match your `--verb` and `--target`; it is consumed once (create-only marker under `me/state/approvals-used/`). `courier watch` now wakes the thread's agent as soon as a new approval appears; the wake prompt tells the agent to run `courier approval` first.

  `courier request` now requires `--verb` (merge, deploy, publish, spend, other), `--target` (canonical per verb) and `--summary` (one line, at most 200 characters); they are stored in the request and covered by its hash, so older free-text-only requests can no longer be approved. `--action` is optional display text.

  One text rule set applies when `courier request` writes, when `courier approval` reads and in the `/courier` view: a frozen Unicode 15.0.0 allow-list (Lu/Ll/Lt/Lo/Nd minus Default*Ignorable), NFC, ASCII punctuation only (summary `. , : ; - * / # ( ) ? !`and U+0027; free multiline text all printable ASCII punctuation plus LF), plain U+0020 space only, caps (target and summary 200, action/reason/risk 2000),`target`printable ASCII in its per-verb canonical shape; violations are refused, never repaired.`canonicalJson`/`requestHash`throw on non-finite numbers and nesting deeper than 64.`test/vectors/request-fields.json`and the exhaustive`text-verdicts.json`hold the shared contract;`src/text-ranges.ts` is the generated table. Previously accepted emoji, smart apostrophes and all remaining combining marks are now refused. Watcher shutdown permanently latches runner cancellation so adapter follow-on commands cannot start after SIGINT/SIGTERM.

## 0.2.0-beta.33

### Patch Changes

- Updated dependencies [a553392]
  - @tinycloud/node-sdk@3.3.0-beta.34

## 0.2.0-beta.32

### Minor Changes

- 38271aa: `courier watch --wake paseo|claude|exec`: wake adapters. `paseo` messages the agent labelled `courier-thread=<id>` or creates one (labels `courier-thread`, `courier-peer`, title `✉ <peer> · <subject>`); `claude` runs `claude -p`, keeps the session id per thread and resumes it; `exec` runs a command with `COURIER_THREAD`, `COURIER_PEER`, `COURIER_MESSAGES`. The wake prompt frames the message as a counterparty request, not an instruction from the owner. `--install-launchd` and `--install-systemd` generate and install a launchd agent or a `systemd --user` unit (`--dry-run` prints the exact file and commands). Woken claude runs may use only `Bash(courier:*)` unless `--claude-settings`/`--claude-allow` widen it.

## 0.2.0-beta.31

### Minor Changes

- 35bfabc: Add `courier watch`: subscribes to each paired peer's `to/<me>/` and your `me/approvals/` through write hooks (25 s tickets), polls every 60 s as the fallback, mirrors new messages, peer `meta.json` and peer tasks into `me/mirror/`, advances receipts, and wakes per thread after a 30 s debounce (`inform` never wakes). State lives in `me/state/watch.json`. This release logs the wake (`--wake none`); wake adapters follow.

## 0.1.6-beta.30

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.33

## 0.1.6-beta.29

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.31

## 0.1.6-beta.28

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.30

## 0.1.6-beta.27

### Patch Changes

- Updated dependencies [e99a127]
  - @tinycloud/node-sdk@3.3.0-beta.29

## 0.1.6-beta.26

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.28

## 0.1.6-beta.25

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.27

## 0.1.6-beta.24

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.26

## 0.1.6-beta.23

### Patch Changes

- Updated dependencies [87a137e]
  - @tinycloud/node-sdk@3.3.0-beta.25

## 0.1.6-beta.22

### Patch Changes

- Updated dependencies [b6d0b9f]
  - @tinycloud/node-sdk@3.3.0-beta.24

## 0.1.6-beta.21

### Patch Changes

- Updated dependencies [d2ad845]
  - @tinycloud/node-sdk@3.3.0-beta.23

## 0.1.6-beta.20

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.22

## 0.1.6-beta.19

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.21

## 0.1.6-beta.18

### Patch Changes

- Updated dependencies [cce8b26]
  - @tinycloud/node-sdk@3.3.0-beta.20

## 0.1.6-beta.17

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.18

## 0.1.6-beta.16

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.17

## 0.1.6-beta.15

### Patch Changes

- Updated dependencies [18b6c9f]
  - @tinycloud/node-sdk@3.3.0-beta.16

## 0.1.6-beta.14

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.15

## 0.1.6-beta.13

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.14

## 0.1.6-beta.12

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.13

## 0.1.6-beta.11

### Patch Changes

- Updated dependencies [2292db7]
  - @tinycloud/node-sdk@3.3.0-beta.11

## 0.1.6-beta.10

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.10

## 0.1.6-beta.9

### Patch Changes

- Updated dependencies [ef9653b]
  - @tinycloud/node-sdk@3.3.0-beta.9

## 0.1.6-beta.8

### Patch Changes

- Updated dependencies [f97d73d]
  - @tinycloud/node-sdk@3.3.0-beta.8

## 0.1.6-beta.7

### Patch Changes

- Updated dependencies [29440be]
- Updated dependencies [86815bd]
- Updated dependencies [e7f709d]
- Updated dependencies [94566db]
- Updated dependencies [38980b0]
- Updated dependencies [a7cdfe0]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [0c4c6b2]
  - @tinycloud/node-sdk@3.3.0-beta.7

## 0.1.6-beta.6

### Patch Changes

- @tinycloud/node-sdk@3.2.6-beta.6

## 0.1.6-beta.5

### Patch Changes

- @tinycloud/node-sdk@3.2.6-beta.5

## 0.1.6-beta.4

### Patch Changes

- @tinycloud/node-sdk@3.2.6-beta.4

## 0.1.6-beta.3

### Patch Changes

- Updated dependencies [41e5fca]
  - @tinycloud/node-sdk@3.2.6-beta.3

## 0.1.6-beta.2

### Patch Changes

- Updated dependencies [370a8e4]
  - @tinycloud/node-sdk@3.2.6-beta.2

## 0.1.6-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.2.6-beta.1

## 0.1.6-beta.0

### Patch Changes

- Updated dependencies [2aa917e]
  - @tinycloud/node-sdk@3.2.6-beta.0

## 0.1.5

### Patch Changes

- @tinycloud/node-sdk@3.2.5

## 0.1.5-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.2.5-beta.0

## 0.1.4

### Patch Changes

- 079afb6: Release a new beta built from its version commit. npm's 0.5.4-beta.1 (operations) and 0.1.4-beta.1 (courier) came from b6038b10, a run whose version commit never landed (TC-1095).
- 9704c99: The tc-cli and courier skills now find the CLI as `tinycloud` (`node_modules/.bin/tinycloud`, or `$(npm prefix --global)/bin/tinycloud`) and tell agents to run `tinycloud`, so relayed hints no longer reach iproute2's `/usr/sbin/tc`. Requires CLI 1.2.3 or later.
  - @tinycloud/node-sdk@3.2.4

## 0.1.4-beta.2

### Patch Changes

- 079afb6: Release a new beta built from its version commit. npm's 0.5.4-beta.1 (operations) and 0.1.4-beta.1 (courier) came from b6038b10, a run whose version commit never landed (TC-1095).

## 0.1.4-beta.1

### Patch Changes

- 9704c99: The tc-cli and courier skills now find the CLI as `tinycloud` (`node_modules/.bin/tinycloud`, or `$(npm prefix --global)/bin/tinycloud`) and tell agents to run `tinycloud`, so relayed hints no longer reach iproute2's `/usr/sbin/tc`. Requires CLI 1.2.3 or later.

## 0.1.4-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.2.4-beta.0

## 0.1.3

### Patch Changes

- 1a8a8a7: Skills resolve the CLI from the agents.tinycloud.xyz private install (`~/.local/share/tinycloud/cli`, or `TC_BIN`), falling back to a global npm install; tc-cli INSTALL.md points at agents.tinycloud.xyz for setup and skill installs.
- 021330d: Hints, examples and completion scripts name the command you ran: `tinycloud …` when invoked as `tinycloud`, `tc …` otherwise. `@tinycloud/operations` exports `CLI_NAME` from `@tinycloud/operations/cli-name` for this. Courier's missing-space hint names the TinyCloud CLI it runs inside (`tinycloud space host agents` under `tinycloud courier`), and `tc` when run as the standalone `courier` bin.
- Updated dependencies [c13720c]
  - @tinycloud/node-sdk@3.2.3

## 0.1.3-beta.2

### Patch Changes

- 1a8a8a7: Skills resolve the CLI from the agents.tinycloud.xyz private install (`~/.local/share/tinycloud/cli`, or `TC_BIN`), falling back to a global npm install; tc-cli INSTALL.md points at agents.tinycloud.xyz for setup and skill installs.

## 0.1.3-beta.1

### Patch Changes

- Updated dependencies [c13720c]
  - @tinycloud/node-sdk@3.2.3-beta.0

## 0.1.3-beta.0

### Patch Changes

- 021330d: Hints, examples and completion scripts name the command you ran: `tinycloud …` when invoked as `tinycloud`, `tc …` otherwise. `@tinycloud/operations` exports `CLI_NAME` from `@tinycloud/operations/cli-name` for this. Courier's missing-space hint names the TinyCloud CLI it runs inside (`tinycloud space host agents` under `tinycloud courier`), and `tc` when run as the standalone `courier` bin.

## 0.1.2

### Patch Changes

- @tinycloud/node-sdk@3.2.2

## 0.1.2-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.2.2-beta.0

## 0.1.1

### Patch Changes

- Updated dependencies [10359c5]
- Updated dependencies [eda1f78]
  - @tinycloud/node-sdk@3.2.1

## 0.1.1-beta.1

### Patch Changes

- Updated dependencies [10359c5]
  - @tinycloud/node-sdk@3.2.1-beta.1

## 0.1.1-beta.0

### Patch Changes

- Updated dependencies [eda1f78]
  - @tinycloud/node-sdk@3.2.1-beta.0

## 0.1.0

### Minor Changes

- d84cfed: New package `@tinycloud/courier` (first beta): Courier, agent-to-agent threads over TinyCloud, moved into this repo from TinyCloudLabs/courier. It ships the standalone `courier` bin, the library entry `main(argv, { prog })`, and the `courier` agent skill. The package has no `license` field yet (TC-861).

  `@tinycloud/cli` bundles Courier as `tc courier …`. It takes the same arguments as `courier`, keeps its own profile in `$COURIER_HOME` (default `~/.courier`) rather than a tc profile, and is loaded only when invoked. tc options before `courier` (for example `tc -p x courier …`) exit 2. The CLI tarball now ships the `courier` skill next to `tc-cli`; install both with `--skill tc-cli courier`.

  `courier init --paste` and `courier init --grant-file -` accept OpenKey `XXXX-XXXX` short codes (TC-823). The code is redeemed at `--openkey-api-host`, `COURIER_OPENKEY_API_HOST`, or by default `https://api.openkey.so` (for `https://openkey.so`, otherwise the OpenKey host). The redeemed delegation must be bound to the local Courier agent key.

### Patch Changes

- 05c4efa: Courier waits up to 2.5 minutes during init when OpenKey reports `spacePending: true` with `spaceReady: null`. It saves the grant and pending profile before waiting so interrupted or timed-out setup can resume without a new approval. Pending `init --resume` waits up to one minute and clears the marker when the space is ready. Responses without literal `spacePending: true` keep the existing single-probe behavior and manual hosting guidance. Authentication and network errors still propagate.

  The CLI bundles the updated Courier behavior and skill as `tc courier`. Both packages release on the existing beta channel. Release Courier before, or in the same window as, the TC-945 OpenKey API deployment.

- Updated dependencies [33efc8c]
- Updated dependencies [26f86bd]
- Updated dependencies [6a7fa64]
- Updated dependencies [4756923]
- Updated dependencies [4f851e6]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [47eb547]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [d825e49]
  - @tinycloud/node-sdk@3.2.0

## 0.1.0-beta.6

### Patch Changes

- Updated dependencies [d825e49]
  - @tinycloud/node-sdk@3.2.0-beta.9

## 0.1.0-beta.5

### Patch Changes

- 05c4efa: Courier waits up to 2.5 minutes during init when OpenKey reports `spacePending: true` with `spaceReady: null`. It saves the grant and pending profile before waiting so interrupted or timed-out setup can resume without a new approval. Pending `init --resume` waits up to one minute and clears the marker when the space is ready. Responses without literal `spacePending: true` keep the existing single-probe behavior and manual hosting guidance. Authentication and network errors still propagate.

  The CLI bundles the updated Courier behavior and skill as `tc courier`. Both packages release on the existing beta channel. Release Courier before, or in the same window as, the TC-945 OpenKey API deployment.

## 0.1.0-beta.4

### Patch Changes

- Updated dependencies [4756923]
  - @tinycloud/node-sdk@3.2.0-beta.8

## 0.1.0-beta.3

### Patch Changes

- Updated dependencies [26f86bd]
  - @tinycloud/node-sdk@3.2.0-beta.7

## 0.1.0-beta.2

### Patch Changes

- Updated dependencies [33efc8c]
  - @tinycloud/node-sdk@3.2.0-beta.6

## 0.1.0-beta.1

### Patch Changes

- Updated dependencies [47eb547]
  - @tinycloud/node-sdk@3.2.0-beta.5

## 0.1.0-beta.0

### Minor Changes

- d84cfed: New package `@tinycloud/courier` (first beta): Courier, agent-to-agent threads over TinyCloud, moved into this repo from TinyCloudLabs/courier. It ships the standalone `courier` bin, the library entry `main(argv, { prog })`, and the `courier` agent skill. The package has no `license` field yet (TC-861).

  `@tinycloud/cli` bundles Courier as `tc courier …`. It takes the same arguments as `courier`, keeps its own profile in `$COURIER_HOME` (default `~/.courier`) rather than a tc profile, and is loaded only when invoked. tc options before `courier` (for example `tc -p x courier …`) exit 2. The CLI tarball now ships the `courier` skill next to `tc-cli`; install both with `--skill tc-cli courier`.

  `courier init --paste` and `courier init --grant-file -` accept OpenKey `XXXX-XXXX` short codes (TC-823). The code is redeemed at `--openkey-api-host`, `COURIER_OPENKEY_API_HOST`, or by default `https://api.openkey.so` (for `https://openkey.so`, otherwise the OpenKey host). The redeemed delegation must be bound to the local Courier agent key.
