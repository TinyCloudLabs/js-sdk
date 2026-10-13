---
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

`signIn()` no longer waits for the account-registry sync (TC-998). In 3.2.0, every app sign-in waited up to 4 s for it, and on production the sync never finished inside that window. The sync runs in the background again, as in 3.1.0, with a 30 s hang guard instead of the 4 s cap, so the app's registry record is written after sign-in. A new sign-in, or a successful `restoreSession()`, stops the replaced session's sync before swapping the session.

`ensureOwnedSpaceHosted()` no longer waits for the sync, and no longer asks for a second `tinycloud.space/host` approval for a space that is already hosted (TC-994). It trusts the sign-in activation, which lists every hosted space the session covers, and the spaces this session has hosted, before it falls back to the registry record. Concurrent hosts of the same space, for example the background sync and the app, share one approval.

Use the new `TinyCloudNode.waitForAccountRegistrySync()` when you need the registry written, or before a first write against a SQLite-backed node older than 1.20.2 (TC-899). Background sync failures are logged as warnings and never surface as unhandled rejections.
