---
"@tinycloud/cli": minor
---

From a delegate (agent) profile, `tc delegation list --granted` lists the delegations that profile's own key issued (every page, each with its `status`, sorted by delegation ID rather than by date), and `tc delegation revoke <cid>` revokes one of them with a revocation signed by that key, so the profile doesn't need a revoke grant from its owner. Revoking one that's already revoked also succeeds. A delegation the key didn't issue is refused with the node's message (exit 5). A node that can't list issued delegations yet answers `ISSUED_DELEGATIONS_UNAVAILABLE` (exit 7). Owner profiles are unchanged.

Details: TC-2132
