---
"@tinycloud/courier": patch
---

Courier no longer loses pairings, revocations or key rotations when two commands use the same profile. A command that holds a copy of `profile.json` for a long time (`init --wait`, `invite serve`) used to save that copy over whatever another command had written meanwhile.

- `profile.json` is saved under a lock (`profile.json.lock`) that uses the intake lock: an `{pid, nonce}` owner record created whole, released only by its own nonce, broken only when its holder is established dead (only when the record names this machine-id and hostname: a different true boot id (Linux boot_id, macOS kern.bootsessionuuid) is a reboot; otherwise a gone pid, or on Linux, within one named pid namespace and only when `/proc` is this process's own view, a zombie or reused pid; clock-derived boot times never decide, and a live pid on macOS or Windows is kept) and by one breaker at a time. A lock is never broken because it is old. If its holder is alive, is on another host or pid namespace, or the record cannot be read, the save waits 10 s and then refuses with `[profile-locked]` and one line naming the lock file, the holder and `rm -f -- <lock>` to clear it once no Courier command is running; the lock is left in place. The save re-reads the file and writes only what the command itself changed: a pairing made, a peer revoked or a renewal imported meanwhile is kept. Two renewals racing keep every outbound delegation and the longer inbound one, so a shorter artifact imported last no longer replaces a longer one.
- A command that started before `init --rotate-key` finished is refused with `[profile-changed]` and writes nothing, including no `grant.json` for the old key.
- Two commands that add the same handle never replace each other's peer or delegations (`[profile-changed]`), and a command whose peer was revoked meanwhile fails (`[peer-revoked]`) instead of printing an artifact.
- A `pending-A` or `awaiting-C` pairing that is more than 7 days old is forgotten.
- Starting a pairing again over a pending one that expired is no longer refused.
- `pair accept` of an artifact A that names an already paired peer is refused (`[usage]`, "Already paired with <peer>") before any delegation is created (a pairing that completes during `delegateTo` is refused with a warning naming the unsaved delegation and where to revoke it), and the pairing is left as it was.
- `courier intake` uses the same lock: a lock it cannot prove dead is kept and its refusal is one line naming the lock file, the holder and `rm -f -- <lock>`, to run only after confirming no Courier command is running.

Details: TC-2384
