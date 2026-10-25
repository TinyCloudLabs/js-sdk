---
"@tinycloud/cli": minor
"@tinycloud/node-sdk": minor
---

`tc auth login --method local --keys <prefix>` also grants named-key create and decrypt on keys below the prefix, and `tc keys ensure|encrypt|decrypt` use them. Node SDK: `additionalRawAbilities` adds top-level resource abilities to the sign-in request.

Details: TC-2034
