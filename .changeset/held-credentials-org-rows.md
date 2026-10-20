---
"@tinycloud/sdk-core": minor
---

Add `ORG_MEMBERSHIP_ROW` (`tinycloud.org-membership/v1`, 365-day lifetime), `ORG_MEMBERSHIP_FREE_ROW` (`tinycloud.org-membership-free/v1`, 30-day lifetime) and `ORG_MEMBERSHIP_ROWS` to `@tinycloud/sdk-core/held-credentials`. Pass the rows as `rows` to `parseIssuerSet` and `verifyHeldPresentation`; the default remains the email row. Each row decides which issuer DIDs it permits: org rows permit opaque org-family DIDs only, and the email row does not permit org-family DIDs. The issuer set loader applies the shipped rows in addition to any rows passed. The shipped rows are frozen. A row's `permitsIssuer` is optional; a row that omits it accepts any issuer its issuer entry permits. `assertValidAudience` is exported for callers that validate audience values. Details: TC-1553
