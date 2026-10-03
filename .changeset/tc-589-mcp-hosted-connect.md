---
"@tinycloud/mcp": patch
---

The hosted MCP connect flow now completes. `tinycloud_connect` accepts a correctly signed OpenKey bootstrap: its account access is checked with the SDK subset check, which considers every signed action together instead of requiring one grant to carry them all. An approved operation delegation is imported as a full `tinycloud.auth.delegation` v1 artifact, and OpenKey's signed-login (CACAO) delegation is verified from its SIWE and accepted, so the retried tool call uses it. Approval callbacks must carry the SIWE, signature, address and chain ID, and access tokens whose owner DID claim holds any malformed value are refused; owner DIDs are canonicalised before they are compared or shown.
