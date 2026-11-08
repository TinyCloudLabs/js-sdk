---
"@tinycloud/share-sdk": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Share publishing no longer creates the share key. `encryptAddressedShareContent` encrypts to the public key of the share's deterministic `share/<shareId>` key (read without authentication) and returns the stored bytes; the node records the key when the share policy is registered. Publishing an addressed share therefore requires a node that records the share key at policy registration. Each published share adds one key record, which counts toward the network's key limit.

Breaking changes:

- `@tinycloud/share-sdk`: `pathBoundSessionPermissions` now returns `decrypt` on `<network>/share/` only (no `key.create`); removed `PathBoundSharePlan.requiredPermissions` and `PathBoundSharePlan.sessionPermissions` (use `registrationPermissions`, decrypt on `<network>/share/`), the `key-not-authorized` and `key-receipt-mismatch` error codes, and `createKey` from `AddressedShareKeyClient` (it now needs only `encrypt`).
- `@tinycloud/sdk-core`: removed `expandRuntimePermissionEntries`; the `<network>/share/` manifest prefix accepts `decrypt` only, so `key.create` there is an invalid manifest entry.
- `@tinycloud/node-sdk`: sign-in accepts only `decrypt` on the `<network>/share/` prefix; runtime permission grants no longer accept `key.create` on an exact `share/<id>` key; removed `RuntimePermissionGrantOptions.expectedSessionKey`.
- `@tinycloud/web-sdk`: `requestPermissions` no longer accepts `key.create` on an exact `share/<id>` key.

`key.create` for `apps/<appId>/` keys (`manifest.keys`) and `NamedKeyClient.createKey` / `ensureKey` are unchanged.

Details: TC-2525
