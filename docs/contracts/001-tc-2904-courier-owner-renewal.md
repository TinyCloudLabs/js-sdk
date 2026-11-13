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

## Producer/consumer source map (OpenKey coordination)

OpenKey main dc68836f: request ingress `apps/api/src/routes/approval-requests.ts:55–70`, pre-sign/admission wrappers143–167; owner managed-key signing `apps/api/src/routes/delegate.ts:1654–1674`, authenticated owner-key signer `apps/api/src/services/managed-key-signing.ts:6–20`; external-owner completion `delegate.ts:2069`, signature recovery2208–2220. Both owner paths must issue the lease or explicitly report unsupported before an approval claims renewable access. One approval interaction does not imply an external wallet can produce two owner signatures with one signing call; preserve the existing identity/signature checks and coordinate that wallet path before promising signature count.

Result producer `apps/api/src/services/approval-results.ts:103–166` validates exact target/JWK/host/permissions/lifetime and encrypts the result only after grant and lease are ready. Consumer `packages/share-envelope/src/links/approval-client.ts:324–402` decrypts and validates request/result binding. The approval `bodyCid`/`requestDigest` identifies the signed request, NOT the original grant's `delegationCid`; the lease targets only the latter. OpenKey currently pins share-envelope1.4.1-beta.1: deploy compatible reviewed request/result codecs together; never send an unchecked renewal field to its existing strict parser.

## Review conditions C1–C7 and proposed codec names

Request optional field: `renewal: { version: 1, leaseLifetimeSeconds: number }` is a requested maximum, not authorization or a hidden selection. OpenKey refuses values above the one-year policy maximum before consent. It independently discovers the space host at its canonical TLS origin and verifies node identity and renewal capability; it accepts no requester-supplied renewer identity. Only an authenticated unsupported-capability signal BEFORE consent offers a visibly finite grant. Discovery errors do not mean unsupported.

Result optional field: `renewal: { version: 1, approvedLeaseLifetimeSeconds: number, approvedAt: string, receipt: RenewalLeaseReceipt }`. The existing resultVersion/requestId/requestDigest/requesterDid/ownerDid/targetDid/delegationExpiresAt/delegation remain. For a finite owner choice, renewal is absent and the result must explicitly bind that chosen finite mode (proposed `renewalChoice: 'finite' | 'leased'` on results for requests carrying renewal). A leased choice requires renewal and a finite choice forbids it. Existing non-renewal requests need no renewalChoice. The envelope is authenticated and encrypted by the existing result protocol; final names/strict schema are for Bobbie and producer agreement before edits.

C1: lease audience is the independently verified node renewerDid, never the agent. Its sole capability is tinycloud.delegation/renew on exact urn:cid:<originalCid>, with no extra actions/resources/caveats. Expiry equals approval time plus the owner's chosen lifetime, no later than the one-year bound. The original grant remains the exact agent-key grant.

C2: OpenKey independently discovers and verifies the actual space host/node identity; requester fields cannot choose a renewal signer. TLS canonical origin and verified node discovery bind the receipt identity.

C3: the owner sees that all listed access, including Sensitive Courier rows, continues to the lease end unless revoked. D4 choices default90d,6mo/1yr, plus shorter or finite; the returned approved lifetime is the visible chosen value, not the requester maximum. Monica owns final words. Sam's card precedes OpenKey deployment.

C4: unsupported fallback occurs only before consent from authenticated capability evidence. After renewable approval, signing/admission/discovery/result failure is refusal/retry, never an implicit finite result.

C5: OpenKey durably binds one original grant and at most one owner lease to requestId plus requestDigest; retries return that same pair. Persist signing/admission progress so crashes do not mint a second lease for the same approval. Completion encrypts the durable pair rather than issuing again.

C6: owner can revoke the lease through dashboard/own-revoke; sign-out and account deletion policy must explicitly cover leases. Deployment prerequisite candidate TC-2874 must be confirmed to include this stop path, or a dedicated tracked issue must be named before deployment. This proposal does not claim that prerequisite is implemented.

C7: persist grant plus leaseAuthorization together with existing secure profile/key protections and transaction binding. Never log leaseAuthorization, grant payloads, or keys. ACK only after durable verified installation.

## Producer integration dependencies and consumer proof

Bobbie approved names plus these constraints: consumer computes originalCid from the actual returned signed delegation bytes, verifies the lease target against that CID, enforces leaseExpiresAt <= approvedAt + approvedLeaseLifetimeSeconds <= approvedAt + one year and approved <= requested maximum. approvedAt is durable server time, sanity-checked against grant/lease expiry. Metadata codec acceptance is not signed-authority verification.

OpenKey currently pins node-sdk/sdk-core2.11.0 and share-envelope1.4.1-beta.1. Pin the exact reviewed published SDK and codec releases on both sides; current installs do not supply this feature. SDK owner must identify/provide the owner-signing/admission primitive targeting the exact agent grant without the agent private JWK. createRenewalLease(Date) is session-bound; substituting an OpenKey session CID is forbidden.

C5 stages on the existing request record: chosen mode, immutable server approvedAt, original signed bytes/CID, lease signed bytes/CID, admission and final result progress. Crash replay reuses identical bytes, nonce, timestamps and CIDs; the short approval claim alone is insufficient. No independent journal or poller. External-wallet decline/failure at signature two returns no half-pair or silent finite result; finite requires explicit consent. C6 coverage must be assigned to an actual scoped issue before deploy, not assumed from TC-2874's title. Producer implementation follows OpenKey496/497 deployment.

## Scheduler headroom (Naomi ruling, 2026-11-13)

Production v1.26.2 scans at startup and every300 seconds, renews only from half-life, and does not wake on lease admission. Courier refuses fresh lease installation with less than15 minutes of original validity remaining (three scheduler intervals), using the distinct fresh-owner-approval error. Exactly15 minutes is admissible at the check. A verified late-crash restore of an already admitted live exact pair does not create a lease and remains recoverable after original expiry. Stamp-on-admission on the node could remove this guard later; no node change is included now. A no-restart smoke uses a greater-than15-minute original (setup margin) and a longer lease; no test-clock or node restart is hidden.

## D11 request purpose (TC-2933 coordination)

The signed request accepts optional `purpose: "task" | "standing"`. Missing always means task; it never inherits standing from a renewal field or checkbox. The codec preserves absent fields rather than rewriting a legacy signed body; `approvalRequestPurpose(request)` resolves the semantic default. Courier explicitly requests standing for its agent grant. Producer pre-ticking is allowed only for explicit standing without secret/decrypt grants, under Naomi/Bobbie review. No consumer consent UI is introduced. Producer and consumer must use the exact reviewed published codec; old strict parsers do not accept the new purpose field. Release/deploy sequencing must therefore deliver the codec to the producer before enabling consumer rollout.
