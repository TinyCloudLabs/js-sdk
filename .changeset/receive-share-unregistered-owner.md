---
"@tinycloud/web-sdk": patch
---

`TinyCloudWeb.receiveShare` opens a link-only share from an owner the registry has no record of (it answers 404 for both the v2 and the v1 lookup) through the host recorded in the link, as it did before 3.12; 3.12 refused it with `node_not_found`. A registered owner is still routed by the registry's hosts, an unavailable registry still refuses, and the link's host is never a fallback for either.

Details: TC-3374
