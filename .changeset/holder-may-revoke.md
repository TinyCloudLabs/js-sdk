---
"@tinycloud/node-sdk": minor
"@tinycloud/cli": minor
---

An agent can give back a grant it was issued. `delegateTo(did, permissions, { holderMayRevoke: true })` also signs and activates a second, revoke-only grant that names just that delegation and ends when it ends, and returns it as `revokeControl`. `tinycloud feed connect` does this by default; `tinycloud delegation create --holder-may-revoke` opts in; share links never do. The grant file carries `revokeControl`, `tinycloud auth import` stores it, and `tinycloud delegation revoke <cid>` from the agent's profile uses it, removing the stored grant only after the node confirms. A grant file without `revokeControl` can still be revoked only by its issuer. Needs a node that admits a revoke-only grant from a delegation's issuer to its recipient. On a node that refuses it, or for a delegation over 31 days, `feed connect` and `delegation create --holder-may-revoke` still create the delegation without the grant and print one line naming `tinycloud feed disconnect --agent <name>` or `tinycloud delegation revoke <id>`; any other failure still fails.

Details: TC-3150
