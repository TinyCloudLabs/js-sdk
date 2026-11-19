---
"@tinycloud/node-sdk": minor
"@tinycloud/cli": minor
---

An agent can give back a grant it was issued. `delegateTo(did, permissions, { holderMayRevoke: true })` also signs a revoke-only grant for that delegation, ending when the delegation ends, and returns it as `revokeControl`. `tinycloud feed connect` does this by default and `tinycloud delegation create --holder-may-revoke` opts in; share links never do. `tinycloud auth import` stores the grant file's `revokeControl`, and `tinycloud delegation revoke <cid>` from the agent's profile uses it, removing the stored grant only after the node confirms. A grant file without `revokeControl` can be revoked only by its issuer.

Give-back needs TinyCloud node 1.26.11 or later. On an older node, for a delegation over 31 days or for a wallet-DID recipient, `feed connect` and `delegation create --holder-may-revoke` create the delegation without the grant and print the command that revokes it. Any other failure stops the command.

Details: TC-3150
