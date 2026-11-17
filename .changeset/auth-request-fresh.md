---
"@tinycloud/cli": minor
---

`auth request --grant --fresh` asks the owner for a new approval even when the current grants already cover the request, which otherwise answers `changed: false` and asks nothing. The old grant is kept (not removed, not revoked) and its CID is listed beside the new one (`existingDelegationCids`). It works with `--timeout`, and needs `--grant` and an OpenKey owner profile (usage error, exit 2, otherwise). Details: TC-3153.
