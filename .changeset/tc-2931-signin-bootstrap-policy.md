---
"@tinycloud/bootstrap": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Scope implicit sign-in bootstrap permissions to approved first-party page origins. Explicit bootstrap opt-out omits implicit account and capabilities-read rows; explicitly requested permissions remain intact. Third-party accounts with no registered route receive a setup-required error with the Home setup URL before signing.

Details: TC-2931
