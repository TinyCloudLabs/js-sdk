---
"@tinycloud/bootstrap": patch
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": patch
---

Consolidate hand-written capability URN lists into a single source of truth
(`@tinycloud/bootstrap` `capabilities` module, TC-112). `SQLAction`,
`DuckDbAction`, the node-sdk default abilities and root-delegation grants, the
bootstrap manifests, and the web-sdk permission-modal labels now all derive
from the shared constants instead of repeating raw URN strings.

BREAKING (minor, pre-1.0): `SQLAction.INSERT` and `SQLAction.UPDATE` are
removed — they were never dispatched by the SDK nor accepted by the node.
`SQLAction.SELECT` is retained as a deprecated alias of `read`. All other
action shapes are unchanged.
