---
"@tinycloud/cli": patch
---

`tinycloud onboard`, run again with a session that still works, now checks that the node hosts the session's space before it goes on. If the space isn't hosted, it waits as it does after an approval (up to 150 seconds or the `--timeout` share), then ends with exit 1 `SPACE_SETUP_PENDING` instead of failing later with "Space not found". A hosted space costs one read and no wait.

Details: TC-2380
