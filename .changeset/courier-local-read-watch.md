---
"@tinycloud/courier": patch
---

`courier read` of an unchanged thread now makes one KV call, the peer's listing. Your own side of the thread comes from a local, per-entry record of your own writes. That record is used for an hour after a listing, then your side is listed again. A peer's renewal marker is read at most every 5 minutes per thread. `courier read --full` lists both sides and fetches everything again.

`courier watch` keeps what it already knows in `<COURIER_HOME>/watch-cache/<agent>.json`: receipted messages, mirrored meta, marker reads and the claim pruning time. A restart or a `--once` run doesn't fetch these again.

A wake or inform put off because the authority check gave no verdict is held for at most 24 hours, then dropped and logged. Imports keep retrying. After 24 hours without a verdict, the human gets one `access-unverified` notice for that peer, and no more until a check succeeds and access is lost again. `courier guard` keeps the mode of `.claude/settings.local.json` whatever the umask. The read cache sets directory modes through no-follow descriptors and never reads or writes through a symlinked directory. The one-time clean-up of the old cache layout deletes only `<thread ULID>.json` files.

Details: TC-2917, TC-2951
