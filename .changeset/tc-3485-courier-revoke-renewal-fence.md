---
"@tinycloud/courier": patch
---

DRAFT: Monica to approve

Closes a race between a peer renewal and a revoke of the same pairing. A renewal now persists its signed successor's CID before the node activates it, so a revoke that has already removed the local pairing by then makes that save refuse and the node never activates the delegation; cleanup after an activation also now runs even when the local pairing is already gone, so the node-side revoke still happens; and a revoke itself now checks for a successor a renewal had just persisted before reporting the pairing fully removed. Together these mean a revoke racing a renewal can no longer leave a child delegation live on the node with no local pairing left to find it.

Details: TC-3485
