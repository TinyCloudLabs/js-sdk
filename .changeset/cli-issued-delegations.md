---
"@tinycloud/cli": minor
---

From a delegate (agent) profile, `tc delegation list --granted` lists the delegations that profile's own key issued (all pages, with `status`; ordered by delegation id, not by time), and `tc delegation revoke <cid>` revokes one of them with a revocation signed by that key, so the profile never asks its owner for a revoke grant. A delegation that is already revoked succeeds with a note; one the key did not issue is refused with the node's message (exit 5); a node without the issued listing answers `ISSUED_DELEGATIONS_UNAVAILABLE` (exit 7). Owner profiles are unchanged.

Details: TC-2132
