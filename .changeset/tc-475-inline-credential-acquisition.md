---
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
---

Add the SDK-owned `<tinycloud-credential-acquisition>` element and controller
for first-party inline credential issuance. The Web SDK now renders the
descriptor-driven ceremony inside the caller's document, reuses the active
TinyCloud/OpenKey session for holder binding, and keeps OpenCredentials
transport, verification, durable storage, and proof submission SDK-owned.
Existing redirect and headless credential-acquisition behavior is unchanged.
