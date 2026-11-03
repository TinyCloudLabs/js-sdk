# `@tinycloud/share-envelope/links`

Typed, issuer-signed link records and the `#v=4` link grammar (`api.ts`, `grammar.ts`, `header.ts`, `record.ts`), plus the
requester side of an OpenKey approval request.

## The approval-request requester

One state machine for whoever asks OpenKey for an approval (the CLI, Courier). Everything below is exported from this subpath
only; the package root and the web-sdk bundle do not reach it.

| file | what it is | impure? |
| --- | --- | --- |
| `approval-entry.ts` | the entry schema (one pending request, `approval-pending.json` v2), `purgeAt`, `localExpiry`, the time constants | no |
| `approval-requester.ts` | `reduce(state, event) -> { state, effects }`, `RULES`, `APPROVAL_EXIT` | no |
| `approval-client.ts` | `classifyReply` (an OpenKey answer -> `Reply`), `callApproval` (one call, classified) | `fetch` only |
| `approval-driver.ts` | `driveApproval(io, requestId, options)`: the one poll/sleep/fetch/verify/commit/ack loop | via `io` |
| `approval-file.ts` | `parseApprovalFile` (v2, CLI v1 array, Courier v1 object), `serializeApprovalFile`, `sweepApprovalFile` | no |

An adapter supplies `io`: a store (`read`/`write`/`remove`, atomic and mode 0600), a transport (`callApproval` with the signing
key), `verify` (local verification of the opened result), `commit` (save the grant durably), a clock and `sleep`.

### Phases

`open` (no result known) -> `discovered` (OpenKey gave a result reference) -> `fetched` (encrypted envelope held) ->
`committed` (the caller saved the grant; only the ack remains) -> `acked` (key-free; kept only until `retainUntil`, for CLI
command entries). A kept-by-clock `hold` is a flag, not a phase: the next run retries.

### Rules that are tested, not conventions

- **`reduce` is pure.** Time and clock skew (`serverDateSkewMs`: local clock minus the reply's HTTP `Date`) are event fields.
- **Write before act.** A step that changes the entry returns `persist` or `purge` before its one next effect (`call`, `sleep`,
  `verify`, `commit` or `finish`).
- **Private keys.** An entry holds the relay key and, for a first sign-in or a staged rotation, a signing key. Every step that drops
  an entry returns a `purge` effect naming the keys it held; a step that keeps an entry never purges. Effects and outcomes carry
  request ids and key *names*, never a key. At `purgeAt` (`E + R + S` while open, `min(resultExpiresAt, E + R) + S` after) no
  state holds a key, held or not.
- **Nothing is kept forever.** `E` is the signed header's `expiresAt`, `S` = 30 s, `R` = 600 s. A run ends by `E + S` (one final
  poll at `E + S`), by the caller's deadline, or by the collect grace (30 s) once approved.
- **First check.** The first discover of a run is made with the full request limit, however late. Pending (exit 8) needs a live
  confirmation from this run and `now < E`; a first check that gets no answer is `unreachable` (exit 6).

### What each OpenKey answer means (`RULES`, keyed `<call>:<code>`)

| answer | outcome | entry |
| --- | --- | --- |
| discover 202 | continue | keep |
| discover 200 | `discovered` | keep |
| discover 410 `expired_request` | `lapsed` (3) | drop |
| discover 410 `expired_request` + `status:"denied"` (or code `request_denied`) | `denied` (11) | drop |
| discover 400 `invalid_request` | `refused` (5), never an expiry | drop |
| discover 404 `not_found` | `lapsed` (3) | drop |
| discover 410 `expired_result`; fetch 404 / 410 / 409 `acknowledged` | `gone` (3) | drop |
| 400 `request_binding` | `refused` (5) | drop |
| 401 `invalid_proof`, clock > 60 s off the `Date` header, before `E + S` | `clock` (12) | keep, held |
| 401 `invalid_proof` after `E + S` (open) | `lapsed` (3) | drop |
| 401 `invalid_proof`, clock sane or `Date` missing | `refused` (5) | drop |
| anything else, 5 in a row | `unexpected` (7) | keep until `purgeAt` |
| no answer until the deadline | `unreachable` (6), or `pending` (8) if confirmed live this run and `now < E` | keep |
| ack 200 / 404 / 409 / 410 | `completed` (0) | drop, or keep key-free until `retainUntil` |
| ack failure (network, other) | `completed` (0) with an `ack-pending` warning | keep (committed) |

`APPROVAL_EXIT`: completed 0, lapsed / gone / abandoned 3, refused 5, unreachable 6, unexpected / internal 7, pending 8, denied 11,
clock 12. The CLI and Courier still print and exit with their own numbers until they adopt the machine; `collectApprovalResult`
and `refuse` are unchanged until then.

### The file

`approval-pending.json`, version 2: `{ version: 2, entries: [...], unrecognized: [...] }`, mode 0600 in a 0700 directory, written
atomically by the adapter. An entry that cannot be read is moved to `unrecognized` with its raw content (never deleted
silently) and purged `24 h + R + S` later. A file written by a newer client (`version > 2`) is reported, not read.
