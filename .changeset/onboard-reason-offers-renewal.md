---
"@tinycloud/cli": patch
---

`tc onboard` no longer promises a renewal in the reason it sends with the sign-in request. The owner chooses in OpenKey whether the sign-in renews, and that box starts unticked. The reason now reads "Set up TinyCloud on this computer: use your apps and see your spaces, for 7 days. You can let it renew for up to 30 days." A sign-in requested for 30 days, which does not renew, is unchanged.

Details: TC-4247
