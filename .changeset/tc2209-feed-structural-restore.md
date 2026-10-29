---
"@tinycloud/sdk-services": minor
---

Add generic owner-authorized structural feed restore and recipient-filtered delivery pages over the current initialized SQL database pair. Bind immutable response content and full card identities to import origins; atomically store each response header, optional private payload, provenance, and default-deny policies in the response database. Existing live response IDs cannot be reclassified as imports. Output cards and responses are not one cross-database transaction.

Require each origin's consistent exact-recipient pending/mapped evidence and a valid deadline or explicit null before dispatch. Keep raw receipts out of agent-readable policy rows. Fail closed on missing or malformed metadata, preserve unrelated SQL failures during coincident cancellation, and retain safe deadlines in notification headers without private payload data. Uncertain handoffs are not automatically resent; external runtime acceptance, deadline checks, and deduplication remain necessary. No exactly-once external execution guarantee or domain-specific CLI importer is added.

Details: TC-2209
