---
"@tinycloud/cli": patch
---

On Node 20, a command that succeeds exits 0 when stopping live replication takes more than 3 seconds, with no `Promise.withResolvers is not a function` error.

Details: TC-4279
