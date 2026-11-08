---
"@tinycloud/cli": patch
---

`tc auth grant` on an OpenKey profile no longer asks "Sign the N entries marked ! above, and the rest of the request? [y/N]" on the terminal for entries beyond the apps-agent preset, and no longer exits 2 with `CONFIRMATION_REQUIRED` without a terminal. It prints the list, with those entries marked `!`, and goes straight to the OpenKey approval, where the owner approves that exact list; the grant is signed only from that approval, as before. `--yes` is still accepted and changes nothing on an OpenKey profile. Local-key profiles are unchanged: entries beyond the preset still need `--yes` or a yes on the terminal.

Details: TC-2527
