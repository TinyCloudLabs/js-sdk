---
"@tinycloud/cli": patch
---

`tinycloud onboard` now asks for a sign-in that renews itself, as `tinycloud auth login` does: a 7-day grant with a renewal lease of up to 30 days from approval, for every `--with` selection. The approval line says so, for example "Set up TinyCloud on this computer: use your apps and see your spaces, for 7 days, renewing for up to 30 days." The owner can approve it without renewal, and the sign-in then ends after its 7 days. With `--expiry 30d` no renewal is asked. A re-run that adds a grant to an existing sign-in is unchanged: that grant does not renew (30 days, or 7 with the Feed).

Details: TC-3522
