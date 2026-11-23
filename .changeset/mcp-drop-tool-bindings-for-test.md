---
"@tinycloud/mcp": patch
---

`@tinycloud/mcp/tools` no longer exports `toolBindingsForTest()`. Only this package's own tests called it. Code that imported it can read `TOOL_BINDINGS` from the same module, which returns the same bindings.

Details: TC-4100
