---
"@tinycloud/sdk-core": minor
---

Add `ORG_MEMBERSHIP_ROW` (`tinycloud.org-membership/v1`, 365-day lifetime), `ORG_MEMBERSHIP_FREE_ROW` (`tinycloud.org-membership-free/v1`, 30-day lifetime) and `ORG_MEMBERSHIP_ROWS` to `@tinycloud/sdk-core/held-credentials`. Rows are opt-in: pass `rows: ORG_MEMBERSHIP_ROWS` to `parseIssuerSet` and `verifyHeldPresentation`; the default remains the email row. Org rows restrict issuer DIDs to opaque org identifiers, and the verifier checks each row's issuer pattern against the presented issuer. `assertValidAudience` is exported for callers that validate audience values. Email row behaviour is unchanged. Details: TC-1553
