---
"@tinycloud/mcp": patch
---

`/claude/mcp` now repeats each tool's title as `annotations.title`. Anthropic's directory portal reads a tool's listing name from there and showed "Missing title annotation. Add annotations.title" for all five tools. Each `annotations.title` equals the tool's existing top-level `title`.

Only that address changes: `/mcp`, `/chatgpt/mcp`, `/grok/mcp` and `/muse/mcp` list their tools exactly as before. `McpStartupSelection` gains an optional `annotationTitles` flag for this; it is off unless set.

Details: TC-2416
