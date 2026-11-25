---
"@tinycloud/share-envelope": minor
---

Approval requests accept an optional `requesterDid`, for when one key signs the link and a different key receives the grant. A request without the field is valid for every version of the parser. Parsers before 1.7.0 refuse a request that carries `requesterDid`, so approvers must upgrade before requesters send it.

Details: TC-3772
