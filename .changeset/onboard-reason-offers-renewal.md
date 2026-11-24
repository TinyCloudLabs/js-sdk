---
"@tinycloud/cli": patch
---

`tc onboard` asks for a 7-day sign-in that renews for up to 30 days. In OpenKey the renewal box starts ticked and the owner can untick it. The reason it sends reads "Set up TinyCloud on this computer: use your apps and see your spaces, for 7 days. It renews for up to 30 days unless you turn renewal off." For `tc auth login` the box starts unticked. A 30-day sign-in that does not renew keeps its reason.

Details: TC-4247
