---
"@tinycloud/share-envelope": minor
---

Add `requestVersion: 2` OpenKey approval requests signed by a stable requester Ed25519 `did:key` distinct from the grant target key (`targetDid` / `targetPublicJwk`).

- `parseApprovalRequest` accepts `requestVersion: 2` with a required canonical prime-order Ed25519 `did:key` `requester` bound to both `issuer` and the link header issuer, while refusing `requester === targetDid`, unknown versions, malformed `requester` DIDs, and header/body issuer mismatches.
- `OpenKeyApprovalRequestV1` is deprecated and aliases `OpenKeyApprovalRequest` (which includes version-2 requests); use `OpenKeyApprovalRequest` and check `requestVersion` before assuming `issuer === targetDid`.
- `createApprovalRequest` accepts an optional `requesterKey` signer and returns the normalized `request`. Omitting `requesterKey` emits `requestVersion: 1` with identical bytes and binding rules; supplying `requesterKey` requires an explicit `requestVersion: 2` request (refusing v1 bodies) and refuses `requesterKey === targetDid` with no v1 fallback.
- `ApprovalRequesterState` adds an optional `requesterSigningKey` (required when `record.header.issuer` differs from `signingKey` for v2, refused for v1). For v2 requests, `discover` proofs are signed by `requesterSigningKey` in both pre-load and post-load phases, while `fetch` and `ack` proofs remain signed by `signingKey` (the target key). This pairs with the OpenKey contract where post-load `discover` accepts a header-issuer proof for v2 requests.
- Version 1 approval requests keep `issuer === targetDid` and single-key `discover`/`fetch`/`ack` proofs unchanged.

Details: TC-3772
