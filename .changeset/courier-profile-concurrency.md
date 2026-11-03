---
"@tinycloud/courier": patch
---

Courier no longer loses pairings, revocations or key rotations when two commands use the same profile. A command that holds a copy of `profile.json` for a long time (`init --wait`, `invite serve`) used to save that copy over whatever another command had written meanwhile.

- `profile.json` is saved under a lock (`profile.json.lock`, released after the save; a lock left by a process that is gone is broken). The save re-reads the file and writes only what the command itself changed: a pairing made, a peer revoked or a renewal imported meanwhile is kept. Two renewals racing keep every outbound delegation and the longer inbound one, so a shorter artifact imported last no longer replaces a longer one.
- A command that started before `init --rotate-key` finished is refused with `[profile-changed]` and writes nothing.
- A `pending-A` or `awaiting-C` pairing that is more than 7 days old is forgotten.
- `pair accept` of an artifact A that names an already paired peer is refused (`[usage]`, "Already paired with <peer>") and the pairing is left as it was.

Details: TC-2384
