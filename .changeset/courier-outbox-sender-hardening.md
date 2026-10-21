---
"@tinycloud/courier": minor
---

The outbox sender (`courier outbox serve`) now refuses to send unless the item is approved and unchanged:

- Each send is bound to an owner-only approval ledger at `<outbox>/approved/<itemId>` (mode 0600), created by `outbox add` before the item. A missing ledger is `refused:not-approved`. Its digest must match the item bytes read in the same open snapshot, or the reply is `refused:hash-mismatch`.
- Items must be the exact canonical bytes written by `outbox add`: no leading whitespace, pretty-printing, duplicate keys, or missing trailing newline (`refused:bad-item`). Items must be owned by the sender uid and mode 0600 (`refused:unsafe-item`).
- A request is one raw frame of at most 64 bytes, `{"v":1,"itemId":"<ULID>"}` followed by a newline, validated before JSON parsing. Any other frame is `refused:bad-request` with zero sends. One frame per connection.
- A reservation that was consumed but has no result is recorded as `uncertain` at startup (`<itemId>.result.json`, state `uncertain`) and is never resent.
- Replies and sender logs carry fixed codes only. They never include item ids, paths, text, or peer ids. Diagnostic logs are capped at 10 per 60 seconds.
- Connections (64) and pending requests (32, refused with `refused:busy`) are bounded separately from the send quota. The socket keeps its 5 second idle timeout.
- Peer policy errors keep the last valid policy and log `outbox.peers-invalid` with a fixed code only.
