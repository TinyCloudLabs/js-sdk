---
"@tinycloud/mcp": patch
---

The hosted MCP serves the OpenAI plugin directory's domain-verification token as plain text at `/.well-known/openai-apps-challenge`. The token comes from `TC_MCP_OPENAI_APPS_CHALLENGE`; when it is unset or blank the path answers 404.

Details: TC-3726
