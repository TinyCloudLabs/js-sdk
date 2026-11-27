---
"@tinycloud/node-sdk": minor
---

Add `isHostedOwnerProofRefusal(error)`. It is true only for the `AccountSetupRequiredError` a sign-in's hosted-owner check ends with, which comes after the owner's approval: the default node does not host the owner's own `applications` space, or it refused the check's read. Any other `AccountSetupRequiredError` returns false. A node that doesn't answer still gives `NodeNotRespondingError`.

Details: TC-4344
