---
"@tinycloud/web-sdk": minor
---

When OpenKey signs a permission request, `requestPermissions` shows no SDK prompt, and OpenKey's approval screen shows the request. The sign request carries the app's name and, for a request made for another app, that app's name (`onBehalfOf`). OpenKey shows them beside the requesting site as the app's own claim, and the signed message doesn't include them. `setRuntimePermissionSigner(signer, { openKey: true })` marks a custom signer as OpenKey's and passes it that display text as the second argument of `signMessage`. Set `openKey: true` only for a signer that shows its own approval screen for every request. Wallets, signers not marked as OpenKey, and OpenKey clients that don't accept the display text show the SDK prompt. For OpenKey users, that prompt doesn't offer "Do not show me again for 30 days".

Details: TC-3704
