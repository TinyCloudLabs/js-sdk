---
"@tinycloud/courier": patch
---

`courier read` of an unchanged thread now makes one KV call, the peer's listing. Your own side of the thread comes from a local, per-entry owner-space record of the writes made under your thread roots. That record is used for an hour after a listing, then your side is listed again. A peer's renewal marker is read at most every 5 minutes per thread. `courier read --full` lists both sides and fetches everything again. The documented meaning of `authority: "self"` in `courier read` output is now "written by an agent of the same owner", because same-owner agents are one principal. The output itself is unchanged.

`courier watch` keeps what it already knows in `<COURIER_HOME>/watch-cache/<agent>.json`: receipted messages, mirrored meta, marker reads and the claim pruning time. A restart or a `--once` run doesn't fetch these again. The file is bound to this agent's DID and space, and each peer's part to that peer's DID, space and session. It keeps only eligible peers, and is deleted with the read cache.

A wake or inform put off because the authority check gave no verdict is held for at most 24 hours, then dropped and logged. Imports keep retrying. After 24 hours without a verdict, the human gets one `access-unverified` notice for that peer, and no more until a check succeeds and access is lost again. A positive verdict restarts an inform's 24 hours even if its post then fails. `courier guard` keeps the mode of `.claude/settings.local.json` whatever the umask. The local caches read and write nothing through a symlinked directory anywhere below `COURIER_HOME`. Each directory is made owner-only through a no-follow descriptor and checked again right before use. The one-time clean-up of the old cache layout deletes only `<thread ULID>.json` files.

Courier now reads entries in batches: `courier read`, `courier inbox`, intake, and the watcher's import and mirroring each read up to 100 keys in one `tinycloud.kv/get` invocation. Before, every entry took its own call. The node is asked to bound each value at 8 MiB. Each entry is still checked on its own. A first read of a 260-entry thread drops from 265 invocations to 7, and importing 130 messages takes 2 reads instead of 130.

Details: TC-2917, TC-2951
