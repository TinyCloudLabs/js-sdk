---
"@tinycloud/operations": patch
"@tinycloud/cli": patch
---

Fixed: `tc secrets get` (and `secrets run`) on a profile whose scoped OpenKey login named only that secret's own key (`…:default/secrets/<name>` with `decrypt`) was refused with "lacks the scoped decrypt authority" and asked for decrypt on the whole network. A signed session reports a grant with no limits as an empty caveat list, and the check that lets the secret's own key stand in for the network decrypt only accepted a grant with no caveats field. An empty caveat list now counts as no caveats; a grant with a real caveat is still refused.

Details: TC-3802
