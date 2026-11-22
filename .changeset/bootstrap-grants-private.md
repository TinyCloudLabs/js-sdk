---
"@tinycloud/node-sdk": patch
---

Account setup's own access is used only by the setup steps. A call your app makes while setup is running, or after it ends or fails, runs with your app's own session and its manifest.

With `includeAccountRegistryPermissions: false`, account setup builds the account index with its own access, and the app's session gets no registry permissions.

Details: TC-3443
