---
"@tinycloud/courier": patch
---

`courier read` of an unchanged thread now makes one KV call, the peer's listing. Your own side of the thread comes from a local, per-entry record of your own writes. That record is used for an hour after a listing, then your side is listed again. A peer's renewal marker is read at most every 5 minutes per thread. `courier read --full` lists both sides and fetches everything again.

`courier watch` keeps what it already knows in `<COURIER_HOME>/watch-cache/<agent>.json`: receipted messages, mirrored meta, marker reads and the claim pruning time. A restart or a `--once` run doesn't fetch these again.

Details: TC-2917
