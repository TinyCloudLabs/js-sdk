---
"@tinycloud/sdk-services": minor
"@tinycloud/cli": minor
"@tinycloud/mcp": patch
---

Add generic owner-authorized structural feed restore and recipient-filtered delivery pages over the current initialized SQL database pair. Bind immutable response content and full card identities to import origins; atomically store each response header, optional private payload, provenance, and default-deny policies in the response database. Existing live response IDs cannot be reclassified as imports. Output cards and responses are not one cross-database transaction.

Before upgrading live watch consumers, the owner must run the current `initializeFeedDatabases` for each existing registered pair; owner connection and import paths also initialize the schema. This creates the three import-metadata tables required by delivery reads. Agents and listeners never create those tables, and missing tables fail closed.

Require each origin's consistent exact-recipient pending/mapped evidence and a valid deadline or explicit null before dispatch. Keep raw receipts out of agent-readable policy rows. Fail closed on missing or malformed metadata, preserve unrelated SQL failures during coincident cancellation, and retain safe deadlines in notification headers without private payload data. Uncertain handoffs are not automatically resent; external runtime acceptance, deadline checks, and deduplication remain necessary. No exactly-once external execution guarantee is added.

Add read-only full card-issuance history with BINARY full-tuple keyset pages, default limit 100 and maximum 1000; reconciliation starts cursorless because this is not a durable tail, and latest-card listing remains unchanged.

Preserve literal own JSON payload keys when validating stored card-history and restored-card envelopes. Preserve completed restore failures during caller-abort races without removing identical-replay readback recovery.

Add `tinycloud feed import --space <full-uri> --file <prepared.json>` for structurally validated FORMAT1 data and immutable scoped owner-only archives, using canonical SDK restore without legacy projection. Regenerate the CLI reference and MCP coverage metadata.

Reject the reserved wildcard runtime recipient during import preflight, before publishing an immutable archive or creating agent schemas.

Details: TC-2209
