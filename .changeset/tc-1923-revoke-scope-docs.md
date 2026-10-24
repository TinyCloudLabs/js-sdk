---
"@tinycloud/cli": patch
"@tinycloud/node-sdk": patch
---

Document that `tinycloud.delegation/revoke` on a space is space-wide, and that the CLI's own fallback asks for 5 minutes and stores nothing. Added to the tc-cli skill docs and the node-sdk README.

Details: TC-1923
