# @tinycloud/courier

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
