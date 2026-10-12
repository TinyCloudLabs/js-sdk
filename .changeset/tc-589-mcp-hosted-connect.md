---
"@tinycloud/mcp": patch
---

The hosted MCP connect flow now completes. `tinycloud_connect` accepts a correctly signed OpenKey bootstrap: its account access is checked with the SDK subset check, which considers every signed action together instead of requiring one grant to carry them all. An approved operation delegation is imported as a full `tinycloud.auth.delegation` v1 artifact, and OpenKey's signed-login (CACAO) delegation is verified from its SIWE and accepted, so the retried tool call uses it.

Hosted mode no longer exposes `tinycloud_auth_import`: delegations reach a hosted tenant only through the OpenKey approval callback, which binds them to the requesting account and the stored request. Approval callbacks must carry the SIWE, signature, address and chain ID. Access tokens are refused unless every owner DID claim is exactly `did:pkh:eip155:<chain>:0x<40 hex>`; owner DIDs are canonicalised before they are compared or shown.
