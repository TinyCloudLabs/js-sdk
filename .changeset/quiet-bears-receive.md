---
"@tinycloud/cli": patch
---

Links from node.tinycloud.xyz or tee.node.tinycloud.xyz work with a profile set to either server, including the CLI's default. To receive a link from another storage server, create a profile for it with `tc profile create <name> --host <server-url>`, then use `tc --profile <name> share receive <link>`.

Details: TC-2594
