---
"@tinycloud/cli": patch
---

`tinycloud secrets network grant` says it lets the recipient read every secret in the network, including secrets added later, and prints the recipient and the end of the grant once it is made. Its JSON output carries `"scope":"whole-network"`.

Details: TC-2307
