---
"@tinycloud/share-envelope": minor
---

Add `requestVersion: 2` OpenKey approval requests signed by a stable requester Ed25519 `did:key` distinct from the grant target key (`targetDid` / `targetPublicJwk`).

- `parseApprovalRequest` accepts `requestVersion: 2` with a required canonical prime-order Ed25519 `did:key` `requester` bound to both `issuer` and the link header issuer, while refusing `requester === targetDid`, unknown versions, malformed `requester` DIDs, and header/body issuer mismatches.
- `OpenKeyApprovalRequestV1` is deprecated and aliases `OpenKeyApprovalRequest` (which includes version-2 requests); use `OpenKeyApprovalRequest` and check `requestVersion` before assuming `issuer === targetDid`.
- `createApprovalRequest` accepts an optional `requesterKey` signer and returns the normalized `request`. Omitting `requesterKey` emits `requestVersion: 1` with identical bytes and binding rules; supplying `requesterKey` requires an explicit `requestVersion: 2` request (refusing v1 bodies) and refuses `requesterKey === targetDid` with no v1 fallback.
- `ApprovalRequesterState` adds an optional `requesterSigningKey`, required for non-code-claim v2 `discover` calls and refused for v1; `fetch`, `ack`, and code-claim `discover` (`approvalCode` + `OpenKey-Delegation-Claim`) sign with `signingKey` (the target key) and succeed without `requesterSigningKey`, while refusing any supplied `requesterSigningKey` that mismatches `header.issuer`.
- For v2, OpenKey accepts the header-issuer (requester) proof for post-load discover ONLY when `approvalCode` is absent (status/resultRef/expiry). Code-claim discover (`approvalCode` + `OpenKey-Delegation-Claim`) keeps the target-key proof. OpenKey selects the verifying key by `isApprovalRequestV2(record.request)` and mode; it never accepts either key.
- Version 1 approval requests keep `issuer === targetDid` and single-key `discover`/`fetch`/`ack` proofs unchanged.

Details: TC-3772
