# TC-2904: Courier owner-grant renewal approval (proposal 1)

Status: proposal for Bobbie and OpenKey review; no runtime schema changes authorized by this document. SDK API baseline: js-sdk #939, dd858faef43fadec69e7284e2311ef68784eb3b9. TC-2234 remains stopped.

## One observable slice

An owner approves Courier once in OpenKey. After the original grant expires, the same agent key and profile can perform an ordinary KV read under a live admitted node renewal. Lease end or revocation refuses that read. Courier never obtains the owner key or signs an owner lease.

## Approval request and result

Extend the signed, hashed approval intent with an optional versioned renewal request (proposed field `renewal: { version: 1, leaseLifetimeSeconds: number }`). Existing requests without this field remain ordinary finite grants. The renewal intent must participate in canonical request hashing, saved-request matching, result binding and owner consent; it must not be silently inferred from a grant lifetime.

OpenKey, while it holds the owner wallet signer, creates the exact original grant, discovers the verified node renewal identity, signs and admits the lease for `urn:cid:<originalCid>`, then returns the existing grant with a versioned renewal receipt. Proposed receipt is #939's `RenewalLeaseReceipt`: originalCid, leaseCid, leaseAuthorization, leaseExpiresAt, leaseGeneration and nodeIdentity (nodeDid, renewerDid, renewerPublicKey, renewerEpoch). The enclosing result remains bound to the request ID/hash and target agent key. Final codec field names require joint review before implementation.

The signed lease, original grant and verified node identity establish authority; receipt metadata alone does not. Validate exact original CID, owner issuer, agent audience/key, space, canonical node origin/identity, renewer identity/epoch, only the renewal capability and requested owner-approved end. Refuse wrong or missing renewal proof when renewal was approved; do not acknowledge/install a partial renewable result as complete. Retry must collect the same durable result, not silently issue a different owner grant or lease.

## Persistence and restore

Persist the original signed grant and its bound renewal receipt together under the existing profile/key transaction before acknowledging the result. Keep original signed expiry intact; do not turn a cached effective expiry into authority. No separate journal or polling service.

Courier consumes `restoreSessionWithRenewal(sessionData, leaseAuthorization)` from #939; the SDK verifies live node status and admitted history before activating expired-original authority. Preserve exact AGENT_GRANT permissions and original signed-duration ceiling independently from effective renewed liveness. Update both early expiry checks and owner-preflight scheduling so original expiry alone cannot reject a valid renewal or create another monthly approval.

## Durations and refusal

Policy source: tinycloud-dev `docs/specs/interviews/delegation-renewal.md`, D4: lease default90 days, options6 months/1 year, user-configurable default, maximum1 year. D6 Month row: Courier original grant30 days. D10 ten-year grant ceiling is not a lease default. Naomi confirmed D4/D6 unchanged: default90 days, owner options6 months/1 year, max1 year; original Month30 days.

Probe node-keys. Only an explicit unsupported capability can select the existing finite-grant approval path; timeout, malformed identity, revoked/expired lease, invalid proof and unreachable status are not evidence of unsupported renewal. They must not silently downgrade an approved renewable result or revive expired authority. A legacy finite grant continues its existing behavior; renewal cannot be retrofitted after its original expiry. Lease lapse/revocation requires explicit normal owner approval, not automatic signing or background approval creation. Temporary unavailable status is retryable without discarding saved grant/lease or creating a new request.

## Ownership and proof

TC-2904 owns the envelope proposal and Courier/CLI consumption. OpenKey builder owns owner signing/admission and consent display after #496/#497 deployment; Monica owns words, Sam's card precedes OpenKey deployment. Bobbie reviews this envelope before runtime contract edits. #939 owner supplies SDK implementation; no duplicate SDK changes.

After approvals and JS-build clearance: one isolated real-node public CLI smoke with synthetic owner/agent, short original and longer lease: init approval -> save -> restart after original expiry -> KV read succeeds -> lease expiry/revocation -> read refuses. No production calls or owner credentials. Full Courier refusal regressions follow the first real slice. No node build without Naomi slot.
