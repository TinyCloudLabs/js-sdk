---
"@tinycloud/courier": patch
---

TC-712: refuse direct gated commands from woken agents and execute approved PR merges through a fixed-argv, single-use broker. Protect guard settings, dependencies and credential paths. Existing hook allow-once workflows must use `courier run-approved <requestId>` instead; publish, deploy and direct pushes require the owner.
