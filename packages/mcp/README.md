# @tinycloud/mcp

Experimental local stdio MCP projection for the canonical TinyCloud operations
package. It starts in `delegate-session` posture and pins one profile at
startup. Owner-profile data execution requires an explicit profile selection
and `--allow-owner-profile`; there is no silent owner fallback.

The tools expose generated operation schemas and canonical structured
envelopes. An agent can inspect account spaces and applications, then request
exact delegated access to list or read KV data in a selected non-secrets
space. Permission requests contain only exact capabilities and redacted
context. Secret values are not written to TinyCloud logs, errors,
stderr, request/delegation files, audit records, generated artifacts, or the
MCP text content channel. MCP hosts may retain structured results in their own
transcripts, which is outside this package’s control.

The package is published as a beta and requires Node.js 20 or newer.

A new `delegate-session` profile has a key but no TinyCloud session. Bootstrap
it once with the CLI by creating an exact `tc auth request --cap ...` artifact,
having the owner grant that request, and importing the result with
`tc auth import`. Start MCP after that import; subsequent exact requests and
imports can use the MCP tools.
