---
"@tinycloud/sdk-services": minor
"@tinycloud/cli": minor
"@tinycloud/mcp": patch
---

Add the shared SQLite Home feed protocol and CLI commands for owner-provisioned agent connections, card publishing, durable responses, acknowledgements, outcomes, and external runtime handoff. Hook readiness and logical database notifications drive response reconciliation. Feed watch uses a durable local SQLite handoff ledger with explicit saved, delivered, and handling states, and supports Bun or Node.js 22.13+.

Support versioned private response payloads saved atomically with their headers and read explicitly through the existing response database authority. Default response notifications and durable handoff copies include only allowlisted headers and payload metadata.

Add opt-in `redactErrors` to SQL query, execute, and batch calls so private response operations receive static errors with known codes and HTTP status before ordinary service-error delivery. Calls without the option retain their existing error details.

Add explicit outbound feed messages without changing card decisions or owner-private state. Messages share immutable response identities, atomic private payloads, and notification-safe handoff. Exact-identity handling reads retain historical acknowledgement and outcome receipts after later answers or messages.

Feed listeners cancel pending response queries on caller abort and stop cleanly for expected cancellation while preserving unrelated query failures.

Refresh the generated MCP skill coverage for the Commander-owned feed commands; no MCP tools are added.

Details: TC-2205
