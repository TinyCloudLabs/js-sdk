---
"@tinycloud/cli": patch
---

An `auth request --grant` (or any approval run without `--timeout`) that is run again after its saved OpenKey request has long expired now makes a new request and prints the new link in the same run. Before, it printed the old, dead link, exited 3, and only the run after that made a new link. A request that expired within the last 11 minutes is still checked with OpenKey first, and runs with `--timeout` are unchanged. The printed link now says when it stops being valid.

Details: TC-3153
