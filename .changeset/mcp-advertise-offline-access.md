---
"@tinycloud/mcp": patch
---

The hosted connector now advertises `offline_access` next to `tinycloud:mcp` in its protected-resource metadata (`scopes_supported`) and in the `scope` of its 401 challenge, on `/mcp` and the chatgpt, claude, grok and muse addresses. OpenKey issues a refresh token only when `offline_access` is granted, and clients take their scope from those two places, so assistants such as Grok that asked for `tinycloud:mcp` alone signed the user out every 12 hours. Access is still granted on `tinycloud:mcp` alone, so tokens issued without `offline_access` keep working.

Details: TC-3186
