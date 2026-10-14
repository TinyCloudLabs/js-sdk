---
"@tinycloud/cli": patch
"@tinycloud/courier": patch
---

The tc-cli and courier skills now find the CLI as `tinycloud` (`node_modules/.bin/tinycloud`, or `$(npm prefix --global)/bin/tinycloud`) and tell agents to run `tinycloud`, so relayed hints no longer reach iproute2's `/usr/sbin/tc`. Requires CLI 1.2.3 or later.
