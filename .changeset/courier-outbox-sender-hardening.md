---
"@tinycloud/courier": minor
---

The outbox sender (`courier outbox serve`) now refuses to send unless the item is approved and unchanged:

- Each send is bound to an owner-only approval ledger at `<outbox>/approved/<itemId>` (mode 0600), created by `outbox add` before the item. A missing ledger is `refused:not-approved`. Its digest must match the item bytes read in the same open snapshot, or the reply is `refused:hash-mismatch`.
- Items must be the exact canonical bytes written by `outbox add`: no leading whitespace or byte-order mark, no invalid UTF-8, no pretty-printing, duplicate keys, or missing trailing newline (`refused:bad-item`). Items must be owned by the sender uid and mode 0600 (`refused:unsafe-item`).
- A request is one frame of at most 64 bytes, `{"v":1,"itemId":"<ULID>"}` followed by a newline, validated before JSON parsing. The frame ends at its first newline. Bytes after that newline that arrive before the request is served refuse with `refused:bad-request` and zero sends. A connection that sends bytes but no complete frame within 5 seconds gets `refused:bad-request`. A connection that sends nothing is closed without a reply. One frame per connection.
- A reservation that was consumed but has no result is recorded as `uncertain` at startup (`<itemId>.result.json`, state `uncertain`) and is never resent. A later request for that item is refused `refused:uncertain`.
- Replies and sender logs carry fixed codes only. They never include item ids, paths, text, or peer ids. Diagnostic logs are capped at 10 per 60 seconds.
- Connections (64) and pending requests (32) are bounded separately from the send quota. Requests are capped at 60 per 60 seconds; excess and pending overflow are refused `refused:busy`. Connections over the cap are closed without a reply. The socket keeps its 5 second idle timeout.
- Peer policy errors keep the last valid policy loaded in this process and log `outbox.peers-invalid` with a fixed code only. If no policy has loaded since start, the outbound cap is 1 per hour until a valid file loads.
