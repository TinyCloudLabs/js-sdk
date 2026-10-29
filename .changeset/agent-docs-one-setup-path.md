---
"@tinycloud/cli": patch
"@tinycloud/mcp": patch
---

The `tc-cli` skill, the MCP skill and both READMEs now describe one agent setup path: start at https://agents.tinycloud.xyz/onboarding, sign in with `tinycloud onboard`, and ask for more access with `tinycloud auth request ... --grant --paste`. Agent guides use Node.js 22.20 or later.

Details: TC-2239
