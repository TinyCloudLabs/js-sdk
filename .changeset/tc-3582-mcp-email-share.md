---
"@tinycloud/operations": minor
"@tinycloud/mcp": minor
"@tinycloud/cli": minor
---

`tinycloud_share_email` (local MCP only) shares a text file with one email address. Pass `content`, `filename` and `recipient`, and optionally `expiresInSeconds` (120 seconds to 30 days, default 7 days). Only the person who proves that address through the built-in OpenCredentials issuer can open it, and TinyCloud emails them the invitation. The link is never returned. If the session can't decrypt, the first call returns `authority_required` with an OpenKey approval link for one key for this invitation, and you call the tool again after the owner approves. If the invitation can't be delivered the share is revoked, and the result says `revoked: true` only once that is confirmed; otherwise it says `revoked: false` and names the share. If the OpenCredentials issuer can't be reached, nothing is shared. The share is recorded in the owner's share history, so `tinycloud share list` shows it and `tinycloud share revoke <id>` ends it. The permission it needs lets the agent save and delete files under the owner's `shares/` folder, so it can delete the owner's other shares but cannot read them. Domain and DID recipients are not supported.

The one-key invitation approval is part of `@tinycloud/operations` (`@tinycloud/operations/invitation-approval`), and the CLI's `share publish --to <email>` uses it.

Upgrading: an invitation approval that is still waiting when you upgrade needs to be approved again.

Details: TC-3582
