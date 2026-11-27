---
"@tinycloud/web-sdk": minor
"@tinycloud/node-sdk": minor
---

Offer account setup to an owner who signed in without an account record. When OpenKey sign-in succeeds through the hosted-owner check (the registry has no record for the owner, and the default node hosts their own space), the owner is offered a way to create a record:

- **Toast:** web-sdk shows a toast, "Finish setting up your TinyCloud account", with a "Set up" button. The click opens OpenKey's account setup for the signing key.
- **Never blocks:** nothing opens by itself, and the sign-in and its session are not held up. The toast stays until the owner clicks it or closes it.
- **Event for apps with their own UI:** `on("account.setup.pending", handler)` gets `{ address, finishSetup() }`; call `finishSetup()` from the owner's click. While any handler is subscribed, the SDK shows no toast of its own.
- **Who is offered it:** only a managed OpenKey key of the signed-in owner. Registered owners, and owners the hosted-owner check refuses, keep their current paths.

node-sdk adds `accountSetupPending`: true while the session stands on a proven hosted-owner check.

Details: TC-4344
