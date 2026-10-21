---
"@tinycloud/cli": minor
---

`auth logout`, `auth rotate`, and replica-enabled `auth login` check the sender share history before they replace the profile's share-history key. If the history holds unexpired shares, or cannot be read, the command refuses with `SHARE_HISTORY_UNEXPIRED` or `SHARE_HISTORY_UNAVAILABLE` (exit 5) and changes nothing. `--force` proceeds anyway on each of these commands, and `auth logout --revoke` skips the check. The new `share history recover` command moves an unreadable history file aside to `share-history-v2.json.unreadable-<timestamp>`: it links the file to that name without overwriting, then removes the original, under the profile lock. It never deletes or overwrites a file. If the history file exists but cannot be read, recover exits 1 with `SHARE_HISTORY_RECOVER_FAILED` and moves nothing. Plain re-login and local-owner profiles are not checked.

Details: TC-1669
