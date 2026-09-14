---
"@tinycloud/share-envelope": major
"@tinycloud/share-sdk": major
"@tinycloud/sdk-core": major
"@tinycloud/node-sdk": major
"@tinycloud/web-sdk": major
"@tinycloud/cli": major
---

Complete the TC-498/TC-500 native-sharing beta cutover. The legacy
broker-backed Share APIs, link/transport compatibility paths, and retired CLI
Share flags are intentionally removed. Use owner-Node native bearer
delegations or signed Policy/v3 addressed shares; this release does not retain
a parallel legacy broker authority plane.
