---
"@tinycloud/courier": patch
"@tinycloud/cli": patch
---

Keep broker configuration outside Courier and resolve the owner's gh credential at runtime without copying it. Woken agents use a separate home and Courier-only identity snapshot. Existing broker token files are no longer used; owners configure the broker again after signing in with gh.

Refuse protected-root traversal, gated executable aliases/copies, local network destinations and additional GitHub, registry and credential-access commands.

Require registered executable identities for tool allowances, including Courier entrypoints and wrappers. Unregistered executables and package launchers fail closed. Protect registered tools from agent edits and preserve the installed census across automatic refreshes; owners refresh it after tool upgrades.
