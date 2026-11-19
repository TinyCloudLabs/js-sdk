---
"@tinycloud/cli": minor
---

New `tinycloud feed disconnect --agent <token>`: an owner removes a connected agent in one step. It reads the grant ID from the owner's feed registry, revokes the grant with the profile's own key (no OpenKey approval), then removes the registry row; a failed revoke leaves the row so it can be retried. Before, `delegation revoke <cid>` from the owner profile failed with TARGET_NOT_FOUND because the owner session cannot list the grants it issued and the CLI kept no record of a `feed connect` grant.

Details: TC-3150
