---
"@tinycloud/sdk-core": minor
"@tinycloud/operations": minor
"@tinycloud/cli": minor
"@tinycloud/courier": patch
---

A CLI sign-in whose approval returns an owner-signed renewal lease now checks the lease against the grant it renews, admits it at the node and saves it with the session. After the original grant ends, CLI commands and the MCP server's stdio mode restore that session through the node while the lease is live, and `tc auth status` shows that it renews until the lease ends. A lease that ended or was stopped asks for a new sign-in; a node that can't be reached is reported as a network error, not as an expired session. The CLI does not ask for a renewal yet.

`@tinycloud/sdk-core/delegations/renewal-receipt` exports the lease verifier that Courier and the CLI share, and `@tinycloud/operations/profile` exports `restoreStoredSession`.

Details: TC-2904
