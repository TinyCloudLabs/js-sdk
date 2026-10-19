# Courier references

Outside projects whose design touches Courier's concerns: agent identity, invitations, discovery, messaging and trust. These are references for design work, not dependencies. Summaries are from each project's own docs at the pinned commits; claims about those projects are theirs, not verified here. Courier's own behavior is in `README.md` and `skills/courier/SKILL.md`, and the spec is `docs/specs/courier-v0.md` in tinycloud-dev (TC-707).

Linear: TC-1419.

## Name note

"Tincan" names three unrelated projects. This file covers the first two; the third is listed so nobody confuses them.

| Name | What it is | Where |
|---|---|---|
| **Tincan** (hosted) | Shared rooms for agents, reached over MCP or HTTP | https://gotincan.com, https://github.com/tincan-ai |
| **Reason Network** | Peer-to-peer team directory and message bus. It was originally called tincan (the install and invite strings still say `tincan`) | https://github.com/reason-machines/reason-network |
| agent-tincan | A relay for agents over Tailscale. Not covered here | https://github.com/mvanhorn/agent-tincan |

## Reason Network

Links: [repo](https://github.com/reason-machines/reason-network) · [DESIGN.md](https://github.com/reason-machines/reason-network/blob/main/DESIGN.md) · [SECURITY.md](https://github.com/reason-machines/reason-network/blob/main/SECURITY.md). Pinned at `e2434a2` (2026-10-17, v0.10.5, MIT OR Apache-2.0).

What it is: one Rust daemon per computer, peers dial each other directly over iroh (QUIC, mDNS on the LAN, relay fallback). Coding agents (Claude Code, Codex, Cursor, Gemini CLI, opencode and others) get MCP tools `list_team`, `send_message` and `check_inbox`.

- **Identity:** a machine is an ed25519 key. A "person" is a name typed at join, not a verified identity. Sessions are named `<person>/<session>`. A removed machine "is not made cryptographically powerless: this is for friends" (DESIGN.md, "Roster").
- **Invitations:** a team link `https://<site>/join/#<ticket>`, where the ticket holds the team id, a reusable link secret and address hints. The joiner runs one command and types a name. Four-word one-time codes also exist. Any member can invite or remove; the link secret is replaced on removal.
- **Discovery:** a replicated, signed roster plus live presence per session (repo, branch, busy or idle, one-line "doing", delivery tier). Agents pick a recipient from `list_team`.
- **Messaging:** `Envelope` frames sent machine to machine with `stored | delivered | held | refused` acks and a sender outbox. Delivery tiers are push (wakes an idle session), turn and pull.
- **Trust:** only roster machines can connect. Peer text is framed as `<reason-message from=…>` and never as the user. Per-machine inbound policy is `accept`, `hold` (approve later) or `refuse`, overridable per person. There is a per-sender rate limit, a cap on consecutive agent-to-agent messages with no human input, and a rule that agents cannot send group messages. An optional `notify` pops a message up on a person's screen for approvals.

## Tincan (hosted)

Links: [site](https://gotincan.com) · [docs](https://gotincan.com/docs) · [agent setup guide](https://gotincan.com/start.md) · [compatibility](https://gotincan.com/compatibility) · [tincan-ai/protocol](https://github.com/tincan-ai/protocol) (draft spec, `9b0b466`, 2026-09-28) · [tincan-ai/tincan-plugin](https://github.com/tincan-ai/tincan-plugin) (CLI and plugins, `6e0e376`, 2026-10-05).

What it is: a room, with channels, messages and files, that agents from different hosts (it lists Grok Bot, Instinct, Meta Muse, Claude Code, Codex, Cursor, Copilot CLI, OpenClaw and Hermes) join with their own identity. The hosted endpoint is `https://app.gotincan.com/mcp`; the protocol repo describes an open HTTP binding that others can implement.

- **Identity:** each agent has its own credential (a bearer token returned at join) and a per-agent private memory vault. The agent's owner is "self-reported context, not verified ownership or authorization" (start.md).
- **Invitations:** a single-use link `ORIGIN/join#INVITE` with the secret in the fragment. The protocol says invites last at most 24 hours, grant membership of one explicit room, and that viewing a link must not redeem it (`spec/core.md`). Newer invites are verified by the creator's running agent; older ones need a fingerprint check and creator approval. A bare invite authorizes joining, not work.
- **Discovery:** `agents_list` inside a workspace, plus a protocol discovery document at `/.well-known/tincan.json`. There is no global directory, and the protocol defers federation between servers.
- **Messaging:** channels with mentions by stable agent ID, replies, idempotency keys on every send, and an event stream (SSE) with replayable cursors. Waking an idle agent depends on the host, and the docs say so; the fallback is a five-minute check. A2A is a proposed bridge, not advertised.
- **Trust:** membership and receipt never imply permission to act (`spec/0001-boundary.md`). Peer messages cannot grant permission or authorize spending. Per-room end-to-end encryption is optional; standard rooms are encrypted at rest and readable by the service. Revoking an agent blocks future reads, not copies already received. Optional screening of outgoing text for privacy leaks.

## How Courier differs

Courier has no hosted hub. Each owner's mailbox is an `agents` space on their own TinyCloud node, access is a scoped, expiring delegation from the owner's key (the owner approves in OpenKey), and pairing is three artifacts passed between the two humans (`src/pairing.ts`). Neither reference ties an agent to a verified owner identity or uses delegations, which is the part Courier already has.
