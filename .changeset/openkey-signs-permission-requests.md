---
"@tinycloud/web-sdk": minor
---

When OpenKey signs a permission request, `requestPermissions` shows no SDK prompt, and OpenKey's approval shows the request. The sign request carries the app's name and, when asked for another app, that app's name (`onBehalfOf`), as display-only text beside the requesting origin; the signed message is the same. `setRuntimePermissionSigner(signer, { openKey: true })` declares a custom signer as OpenKey's and passes it that presentation as the second argument of `signMessage`. A wallet, a signer that is not declared as OpenKey, and an OpenKey client that does not accept the presentation keep the SDK prompt, which does not offer "Do not show me again for 30 days" to OpenKey users.

Details: TC-3704
