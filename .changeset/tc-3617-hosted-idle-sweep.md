---
"@tinycloud/mcp": minor
---

The hosted MCP retires an idle delegate after the later of its last verified approval and its last authenticated use accepted by the node. A sweep starts one minute after startup and normally runs hourly; accounts become eligible after six days. After the node confirms retirement, the hosted MCP deletes exactly the paths it keeps for the delegate: under `.tinycloud/profiles/agent/` the key, profile, session, additional grants, auth requests, registry caches and sequences with their metadata, delegation-binding record, `pending/` and `.lock/`; under `.tinycloud/` the native grant, call marker, lease exposures, `profile-locks/` and the `retiring` fence; and any atomic-write temporary of these. The fence goes last, so a removal that stops after the key is finished by the next sweep without asking the node again. Every other file in the account's state directory, such as the owner's `tc-apps.json`, is left as it is. The node refuses further use and renewal. If the node cannot confirm retirement, the server keeps the state and retries.

Disconnecting an assistant does not immediately stop renewal. To stop renewal directly, use OpenKey Settings → Renewing permissions → Stop renewal.

Details: TC-3617
