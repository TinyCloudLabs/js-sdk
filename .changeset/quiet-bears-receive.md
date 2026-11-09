---
"@tinycloud/cli": patch
---

To receive a share link, use a CLI profile set to that link's storage server. Create one with `tc profile create <name> --host <server-url>`, then use `tc --profile <name> share receive <link>`.

Details: TC-2594
