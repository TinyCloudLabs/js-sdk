---
"@tinycloud/web-sdk": patch
---

`TinyCloudWeb.receiveShare` opens a link-only share from an owner the registry has no record of through the host recorded in the link, which must be https (or http on loopback, for local nodes). A registered owner is still routed by the registry's hosts, and an unavailable registry still refuses.

Details: TC-3374
