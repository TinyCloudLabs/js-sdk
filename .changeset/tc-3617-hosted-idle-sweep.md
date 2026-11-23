---
"@tinycloud/mcp": minor
---

The hosted MCP retires an idle delegate after the later of its last verified approval and its last authenticated use accepted by the node. A sweep starts one minute after startup and normally runs hourly; accounts become eligible after six days. After the node confirms retirement, the hosted MCP removes the delegate key, session, grants and pending approvals. The node refuses further use and renewal. If the node cannot confirm retirement, the server keeps the state and retries.

Disconnecting an assistant does not immediately stop renewal. To stop renewal directly, use OpenKey Settings → Renewing permissions → Stop renewal.

Details: TC-3617
