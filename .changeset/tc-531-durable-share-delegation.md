---
"@tinycloud/sdk-core": minor
"@tinycloud/web-sdk": minor
"@tinycloud/node-sdk": minor
"@tinycloud/share-sdk": minor
---

Durable, re-delegatable share access (TC-531) and email delivery for
email-domain shares (TC-530).

- **Durable sessions.** Policy admission asks the Node for a session as long
  as the share: `requestedExpiresAt`, which defaults to the policy's expiry
  and can be set to `null` for the legacy minute. On Nodes before 1.17.3,
  which reject the field with 422, it falls back to the 60-second session.
  Received sessions longer than 60 seconds are accepted, but never beyond the
  share's expiry (and at most the 31-day root bound).
- **Re-delegation.** `ReceivedShare.delegate({ to, expiresAt? })`
  re-delegates a received share, decryption included, to another Ed25519
  `did:key`, for example an account session key. It imports the new link into
  the owner's Node and returns the whole chain. The delegate opens the share
  with `share.receive(url, { delegation })` and needs no credential.
  `ShareRecipientClient` verifies every link before use: issuer, the exact
  parent proof, a strictly narrower window, inherited facts with one less
  redelegation, and unchanged capabilities.
- `signCompactPolicyDescendant` signs a policy descendant with a
  caller-owned, possibly non-extractable, key.
- **Default to the maximum.** These now default to the longest their parent
  allows, instead of a minute or an hour:
  - policy descendants;
  - `createSubDelegation`;
  - sessions activated from a received delegation.
- **Domain shares** may grant edit access and may be emailed, like exact-email
  shares. Addressed publishing now refuses unknown policy actions for every
  share kind.
