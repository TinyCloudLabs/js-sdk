---
"@tinycloud/bootstrap": patch
"@tinycloud/sdk-services": patch
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Consolidate hand-written capability URN lists into a single source of truth
(`@tinycloud/bootstrap` `capabilities` module, TC-112). `SQLAction`,
`DuckDbAction`, the node-sdk default abilities and root-delegation grants, the
bootstrap manifests, and the web-sdk permission-modal labels now all derive
from the shared constants instead of repeating raw URN strings. Behavior is
unchanged; the public `SQLAction`/`DuckDbAction` shapes are preserved.
