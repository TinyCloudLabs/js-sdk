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
tc courier request <threadId> --peer bob --task <id> --action "…" --why "…"
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
  `me/state/watch.json`, so a restart does not lose or repeat them.

Every step logs one JSON object per line on stdout (`start`, `hook-event`,
`delivered` with `via` and `latencyMs`, `woke`, errors). `--wake none` (the
only adapter so far) wakes nobody; the `woke` line still records when a wake would fire. `--once` does a single catch-up pass,
wakes immediately and exits. Run one watcher per profile: a second one fails
with `state-conflict` on its first state write. Wakes are at-least-once: a
crash between a wake and the state write wakes that thread again on restart.
When a subscription is re-opened the watcher also runs a catch-up sync; the
SDK's own ticket renewals are invisible to it, and the poll covers those gaps.

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
