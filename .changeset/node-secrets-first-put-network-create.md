---
"@tinycloud/node-sdk": patch
---

`NodeSecretsService.put` now creates the default encryption network before the first write when the session holds `tinycloud.encryption/network.create` for it and no `decrypt` grant. Creation is de-duplicated across concurrent puts and cached per network id for the session, so later puts do not call it again. A failed create returns `NETWORK_ERROR` without writing and is retried on the next put. Sessions that already hold `decrypt`, or that lack `network.create`, keep the previous put behavior. This is an interim step until named keys land in TC-1777.

Details: TC-1777
