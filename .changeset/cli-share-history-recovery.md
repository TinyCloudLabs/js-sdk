---
"@tinycloud/cli": patch
---

`auth logout` and `auth rotate` check the sender share history before they replace the profile's share-history key. If the history holds unexpired shares, or cannot be read, the command refuses with `SHARE_HISTORY_UNEXPIRED` or `SHARE_HISTORY_UNAVAILABLE` (exit 5) and changes nothing. `--force` proceeds anyway, and `auth logout --revoke` skips the check. The new `share history recover` command moves an unreadable history file aside by an atomic no-clobber rename to `share-history-v2.json.unreadable-<timestamp>`, under the profile lock; it never deletes or overwrites a file. Plain re-login and local-owner profiles are not checked.

Details: TC-1669
