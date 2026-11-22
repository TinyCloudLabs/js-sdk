---
"@tinycloud/share-envelope": minor
---

Add `requestVersion: 2` OpenKey approval requests signed by a stable requester Ed25519 `did:key` distinct from the grant target key (`targetDid` / `targetPublicJwk`).

- `parseApprovalRequest` accepts `requestVersion: 2` with a required canonical Ed25519 `did:key` `requester` bound to both `issuer` and the link header issuer, while refusing `requester === targetDid`, unknown versions, malformed `requester` DIDs, and header/body issuer mismatches.
- `createApprovalRequest` accepts an optional `requesterKey` signer; omitting it emits `requestVersion: 1` with identical bytes and binding rules, and supplying it signs the link with `requesterKey` and emits `requestVersion: 2`.
- Version 1 approval requests keep the `issuer === targetDid` binding unchanged, and approval-result `discover`/`fetch`/`ack` proofs remain signed by the target key.

Details: TC-3772
