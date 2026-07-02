---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

TC-86: browser auto-sign bootstrap support. `TinyCloudWeb` config accepts `signStrategy` and forwards it to `TinyCloudNode`, sign requests carry a `purpose` tag (`sign-in` / `bootstrap-session` / `bootstrap-host` / `message`) so strategies can route bootstrap signatures to OpenKey's server-side signer, and account-bootstrap failures degrade to a skipped bootstrap surfaced via `bootstrapStatus` instead of failing `signIn()`.
