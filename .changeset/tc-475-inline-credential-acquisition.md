---
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
---

TC-475 adds the additive `UNSUPPORTED_VERSION` credential-acquisition error
and a host-owned inline credential interaction adapter. Inline hosts receive
only the local proof callback: OpenCredentials locators, request verifiers,
and proof submission remain SDK-owned. Existing popup, redirect, and headless
credential-acquisition behavior is unchanged.
