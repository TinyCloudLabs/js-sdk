---
"@tinycloud/web-sdk": minor
---

The permission prompt from `requestPermissions` now says exactly what each requested permission grants, in one plain line built from the request itself: the exact resource, each action and how long it lasts. For example, a request for `decrypt` and `key.create` on one secret's key for 7 days reads "Create and decrypt with the key secrets/scoped/tinychat-bot-history/bot-history (only this key), for up to 7 days." A request on one key or key prefix no longer shows the network-wide labels ("Use Encryption network", "Decrypt data keys for this network"); a request on a whole encryption network says it is the whole network. An action the prompt has no words for is shown by its name.

`requestPermissions` takes a new optional `caption` (a string): the app's own short label for the request, such as "TrustBot's chat history". The prompt shows it as plain text beneath the derived line, as "Label from <app>: …", and never in its place. It is folded to one line and cut to 120 characters. A signer that shows the request itself (OpenKey) does not show it.

Details: TC-4222
