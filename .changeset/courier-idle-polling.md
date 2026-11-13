---
"@tinycloud/courier": patch
---

`courier watch` makes far fewer node calls while idle:

- It lists every peer in full every 5 minutes while its hook subscriptions are healthy, instead of every minute. Hook events still deliver at once. A failed or ended subscription catches up at once and brings back the full listing every `--poll` seconds until a new stream is healthy. A peer whose sync did not finish is listed again at the next minute.
- A catch-up lists the pause markers once for all peers, reads receipts only when the listing holds a message they are not known to cover, and lists known threads only for a peer's pause notice.
- The renewal and authority check runs every 5 minutes, so detecting an idle revocation and cleaning up sibling grants takes up to 5 minutes. Enforcement is unchanged: the node refuses revoked grants. It also runs before anything is imported from a peer whose last check is older than `--poll`, on a hook event for a peer's renewal marker, and after a refusal. That check reads the marker first, and a refused sync is retried only under a different grant.

Watcher state (`watch.json`, pause markers, wake claims) now lives under `me/state/agents/<did:key id>/` for each Courier agent, so two agents of one owner can run in one space without a state conflict. `courier pause` and `courier resume` use the same keys. The old shared `me/state/` records for an agent's own peers are copied on its first start and left in place. A second watcher of the same agent no longer exits with `state-conflict`, which `Restart=always` turned into a restart and catch-up loop. It stands by instead, checks `watch.json` once per window (5 to 30 minutes), and takes over after a quiet window. `--once` still exits with `state-conflict`.

`courier intake` doubles its wait after a cycle that queued nothing, up to 5 minutes or `--interval` if that is longer, and returns to `--interval` on the next queued message. `courier read` caches create-only messages and meta in `<COURIER_HOME>/read-cache/`, so reading an unchanged thread again fetches only its listings and tasks.

Details: TC-2917
