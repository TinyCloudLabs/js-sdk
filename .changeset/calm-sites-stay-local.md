---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
"@tinycloud/cli": patch
---

Stop implicitly probing `127.0.0.1` during TinyCloud host discovery. Loopback
discovery now requires an explicit `localNodeUrl`, while configured and
registry-discovered `*.local.tinycloud.link` nodes continue to work.
