---
"@tinycloud/courier": patch
---

Courier no longer renews a peer's access for longer than that peer accepts. Peers on Courier 0.5.x refuse anything over 7 days, so a 30-day renewal cut them off. The renewal now lasts at most the lifetime of the access the peer gave you (7 days when that is 7 days or unknown, up to 30 days when it is longer), and never past your own approval. `pair renew` and `courier status` show "peer limit" when this shortens a renewal. Nothing about pairing or stored data changes.

Details: TC-3159
