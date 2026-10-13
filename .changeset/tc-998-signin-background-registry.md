---
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

`signIn()` no longer waits for the account-registry sync (TC-998). In 3.2.0 every app sign-in waited up to 4 s for it, and on production the sync never finished inside that window. The sync runs in the background again, as in 3.1.0, with a 30 s hang guard instead of the 4 s cap, so the app's registry record is written after sign-in. A new sign-in stops the previous session's sync before replacing the session.

`ensureOwnedSpaceHosted()` no longer waits for the sync, and no longer asks for a second `tinycloud.space/host` approval for a space that is already hosted (TC-994). When the registry has no record (a slow, failed or 404 registry read), it asks the node through session activation, which needs no signature. It hosts only if the node doesn't report the space hosted, and only after the background sync (which can host the account space itself) has settled.

Use the new `TinyCloudNode.waitForAccountRegistrySync()` when you need the registry written, or before a first write against a SQLite-backed node older than 1.20.2 (TC-899). Background sync failures are logged as warnings and never surface as unhandled rejections.
