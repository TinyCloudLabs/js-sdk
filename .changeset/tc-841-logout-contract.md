---
"@tinycloud/sdk-services": minor
"@tinycloud/node-sdk": minor
"@tinycloud/replica": minor
"@tinycloud/cli": patch
---

`ProfileReplicaPurge.deny` with `{ deferErase: true }` now accepts only `reason: "sign_out"` and returns `ProfileReplicaDeferredDenyOutcome`, whose committed `denied` always carries `resumeToken`. `ReplicaEraseReport.deferred: true` marks a pass held by a deferred denial, so `remaining: 0` there is not completion. node-sdk exports the full contract `ProfileReplicaPurge`, requires the displayed `approval` in `prepareLogoutPending`, and reports `purgePending` from inspected status while a deferred denial or any intent remains.

A v1 logout marker records the epoch its denial actually committed (`deniedEpoch`) in the same locked section as the deny, and every later check compares with it. A sign-out interrupted between its deny floor and gate writes is completed by the next `auth logout` (`@tinycloud/replica/profile-gate` adds `readLogoutGate`, `advanceInactiveGate` and `REPLICA_DENY_FLOOR_FILE`); reads report "a previous sign-out was interrupted; re-running `tc auth logout` completes it". A restored older gate under a recorded denial refuses with the `tc profile delete` route.

`auth logout` by an account other than the one whose replicas the profile holds writes no marker and leaves that account's gate, floor and replicas untouched: it signs out, removes its own session and key, and erases the profile's legacy `replicas/` mirror (replayed at startup after a crash). `--revoke` there revokes only grants on the signed-in account's spaces.

When startup recovery refuses a pending logout because a credential file is unreadable, the message now names that file (`session.json` or `profile.json`).

CLI-bound storage and purge name the CLI's `replication/events.jsonl` and `events.jsonl.1` diagnostics logs (`diagnosticFiles`). With a readable gate, those exact names count as known only while they are regular files, so a fully synced profile signs out without `--discard-local-changes`; a symlink there stays unknown.
