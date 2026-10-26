---
"@tinycloud/node-sdk": patch
---

Account bootstrap signs two sessions, one for the account space and one for the secrets space, and each carries only what its steps write: the account registry keys (`applications/`, `spaces/`), the account index database and network creation for the account space (plus the completion marker when the sign-in session does not already cover writing it); the `secret_records` schema for the secrets space. Each session lasts 10 minutes, a `siweConfig` can shorten that window but not lengthen it or move its start, and the session is installed only while the bootstrap steps and the completion marker run and is removed when they finish or fail. The other four bootstrap spaces are still hosted by their wallet-signed host steps.

App invocations are signed only by grants the app's manifest session covers. After a `privateKey` sign-in that runs bootstrap, calls outside the manifest to the applications, agents and public spaces, to secrets `variables/` and to sql `default`, and (with `includeAccountRegistryPermissions: false`, for example `@tinycloud/server` `createServerIdentity`) to the account registry, get 401, and `delegateTo` for those throws `PermissionNotInManifestError`. Request them in the manifest or through `grantRuntimePermissions`.

Details: TC-2038
