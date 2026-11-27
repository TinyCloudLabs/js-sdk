---
"@tinycloud/web-sdk": minor
---

On a third-party site, signing in with OpenKey no longer stops at `AccountSetupRequiredError` when the owner has no registry record and OpenKey can set the account up. `signIn()` opens OpenKey's account setup page, using `setupAccount()` from `@openkey/sdk` 0.13.0-beta.5 or later. The owner sets the account up there, and the sign-in then runs again: it reads the registry afresh and asks OpenKey to approve. In popup mode, if the browser blocks that approval popup (the owner's clicks went to OpenKey's window), the SDK asks once more in OpenKey's frame.

Setup is offered for two refusals, and only for a managed OpenKey key that matches the account signing in:
- the registry's refusal, which comes before OpenKey is asked to approve anything
- the hosted-owner check's refusal, which comes after the approval: the app asks only for its own `applications` space, and the default node does not host that space. The sign-in after setup needs the owner's approval a second time.

`signIn()` still rejects with the same `AccountSetupRequiredError` when:
- the owner cancels, or setup doesn't finish
- the key is a wallet key (those are set up in TinyCloud One)
- the OpenKey client has no `setupAccount`
- any other refusal comes after OpenKey's approval

Details: TC-4344
