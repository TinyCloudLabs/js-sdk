---
"@tinycloud/operations": patch
"@tinycloud/mcp": patch
---

A call refused for invalid input now says which field failed and what it accepts, for example `The operation input is invalid. timezone: An IANA timezone is required.` or `... sql: SQL must be one SELECT or WITH query.` Until now every such call answered only `The operation input is invalid.`, which gave an assistant nothing to correct.

The message is built from schema-owned text only: the declared top-level field, array positions, the schema's own message, a type or a limit. Keys and values from the input never appear in it. Refusals of a personal-record key or prefix now describe the accepted layout.

Error codes, `details.issues`, `retryable`, result shapes and the MCP `isError` behaviour are unchanged. No tool name, schema, description or annotation changes, so `tools/list` is byte-identical on every hosted address.

Details: TC-2416
