---
"@tinycloud/share-envelope": minor
---

Approval requests accept an optional `requesterDid` for a distinct requester signing the link while the target key receives the grant. Requests without the field retain their existing encoding and validation. Parsers older than this version refuse requests carrying `requesterDid`; approvers must upgrade before requesters send the field.

Details: TC-3772
