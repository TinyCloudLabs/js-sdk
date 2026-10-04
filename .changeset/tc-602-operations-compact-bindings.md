---
"@tinycloud/operations": patch
---

Runtime replay now holds stored compact-UCAN delegations to the request they were imported against. `tinycloud.auth.import` stores that request (`authorityRequest`) with each delegation, and replay installs a record only when its binding is valid and the delegation's signed capabilities fit inside it, using the same containment check as import. The check runs before anything is activated, so a delegation broader than its binding is never installed. Re-importing a stored delegation that has no binding, against a request it fits, adds the binding.

Records stored before bindings existed are migrated once per profile. The first authenticated runtime that finds no `delegation-binding-migration.json` marker in the profile replays unbound records as before, binds each one whose signed authority it read to exactly that authority (request ID `migrated:<cid>`, with an `authorityRequestMigration` audit note), and then writes the marker. After that, a record without a valid binding installs nothing in the runtime: for example, one written by an unbound `tc auth import` or pasted into the file. A migrated record never grants more than it did before migration, because any delegation in it must fit inside the capabilities it was bound to.

The binding is local profile data. It stops records written by other paths from granting runtime authority. It does not stop someone who can write the profile directory, who already holds the session key and the signed bytes.
