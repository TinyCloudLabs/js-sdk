# @tinycloud/mcp

Experimental local stdio MCP projection for the canonical TinyCloud operations
package. It starts in `delegate-session` posture and pins one profile at
startup. Owner-profile data execution requires an explicit profile selection
and `--allow-owner-profile`; there is no silent owner fallback.

The six initial tools expose generated operations schemas and canonical
structured envelopes. Permission requests contain only exact capabilities and
redacted context. Secret values are not written to TinyCloud logs, errors,
stderr, request/delegation files, audit records, generated artifacts, or the
MCP text content channel. MCP hosts may retain structured results in their own
transcripts, which is outside this package’s control.

CLI/MCP package publication is currently deferred: the I0 MCP SDK v2 gate is
`unpublishable-defer` while the SDK remains beta. This package is private until
that gate changes or product explicitly approves beta publication.
