---
"@tinycloud/cli": minor
---

`tinycloud onboard` sets up a computer to act for its owner: it creates the profile (the default one unless `--profile` or `TC_PROFILE` names another), then asks for two OpenKey approvals, each for 30 days. The first signs the owner in, or lets them create an account, and grants read and write on their `applications` space. The second grants read-only `spaces/` and `applications/` in their `account` space. Each run does the next approval and never waits: it prints JSON with the approval link and exits 8, and the next run takes the code OpenKey shows with `--code`. It exits 0 with `"onboarded": true` once both are granted, and again on every later run until they expire. The `tc-cli` skill describes it under "Sign in".

Details: TC-2168
