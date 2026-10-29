---
"@tinycloud/sdk-services": minor
"@tinycloud/cli": minor
---

Add the shared SQLite Home feed protocol and CLI commands for owner-provisioned agent connections, card publishing, durable responses, acknowledgements, outcomes, and external runtime handoff. Hook readiness and logical database notifications drive response reconciliation. Feed watch uses a durable local SQLite handoff ledger with explicit saved, delivered, and handling states, and supports Bun or Node.js 22.13+.

Support versioned private response payloads saved atomically with their headers and read explicitly through the existing response database authority. Default response notifications and durable handoff copies include only allowlisted headers and payload metadata.

Add opt-in `redactErrors` to SQL query, execute, and batch calls so private response operations receive static errors with known codes and HTTP status before ordinary service-error delivery. Calls without the option retain their existing error details.

Details: TC-2205
