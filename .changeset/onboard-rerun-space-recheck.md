---
"@tinycloud/cli": patch
---

`tinycloud onboard` run again with a session that is still usable now asks the node whether the session's space (the one OpenKey hosts first) is hosted before it goes on. A space the node does not host yet is waited for like after an approval (the same backoff, up to 150 seconds or the `--timeout` share, then exit 1 `SPACE_SETUP_PENDING`), instead of the run going on to a step-2 "Space not found". A hosted space costs one read and no wait. A session that cannot read the space, or a node that cannot be reached, never waits. A run that took an approval itself does not ask again.

Details: TC-2380
