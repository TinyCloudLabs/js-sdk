---
"@tinycloud/share-envelope": minor
---

Add `requestVersion: 2` OpenKey approval requests signed by a stable requester Ed25519 `did:key` distinct from the grant target key (`targetDid` / `targetPublicJwk`).

- `parseApprovalRequest` accepts `requestVersion: 2` with a required canonical prime-order Ed25519 `did:key` `requester` bound to both `issuer` and the link header issuer, while refusing `requester === targetDid`, unknown versions, malformed `requester` DIDs, and header/body issuer mismatches.
- `OpenKeyApprovalRequestV1` is deprecated and aliases `OpenKeyApprovalRequest` (which includes version-2 requests); use `OpenKeyApprovalRequest` and check `requestVersion` before assuming `issuer === targetDid`.
- `createApprovalRequest` accepts an optional `requesterKey` signer and returns the normalized `request`. Omitting `requesterKey` emits `requestVersion: 1` with identical bytes and binding rules; supplying `requesterKey` requires an explicit `requestVersion: 2` request (refusing v1 bodies) and refuses `requesterKey === targetDid` with no v1 fallback.
- `ApprovalRequesterState` adds an optional `requesterSigningKey`, required for non-code-claim v2 `discover` calls and refused for v1; `fetch`, `ack`, and code-claim `discover` (`approvalCode` + `OpenKey-Delegation-Claim`) sign with `signingKey` (the target key) and succeed without `requesterSigningKey`, while refusing any supplied `requesterSigningKey` that mismatches `header.issuer`.
- OpenKey contract (follow-up OpenKey PR):
  - For v2, the consent sheet MUST show the asker (the requester label) and the recipient (the target) as separate lines; when `requester !== targetDid`, the copy must state who receives the access, not only who asked.
  - For v2, OpenKey MUST verify `request.requester === header.issuer` on both the pre-load and post-load paths and never trust a `requester` field the header did not sign.
  - For v2, OpenKey accepts the header-issuer (requester) proof for post-load `discover` ONLY when `approvalCode` is absent (status/`resultRef`/expiry). The requester key MUST be refused wherever `approvalCode` is present (`approvalCode` + `OpenKey-Delegation-Claim`) and for `fetch`/`ack`, which keep the target-key proof. OpenKey selects the verifying key by `isApprovalRequestV2(record.request)` and mode, never either key.
  - The session proof binds `cred_hash` over `[action, requestId, bodyCid, resultRef, ackId, ...codeBinding]`, `htu` (origin + path with `requestId`), `htm`, `iat`, and `jti` (`packages/share-envelope/src/links/approval-client.ts:161-168`). OpenKey MUST check `cred_hash` and `htu` against the actual request, enforce a short `iat` window, and treat `jti` as single-use so a captured requester-signed `discover` proof cannot be replayed against another request.
- Version 1 approval requests keep `issuer === targetDid` and single-key `discover`/`fetch`/`ack` proofs unchanged.

Details: TC-3772
