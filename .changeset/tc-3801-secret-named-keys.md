---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Each secret is sealed to its own key, `secrets/<name>` (or `secrets/scoped/<scope>/<name>`), so one secret can be shared without the others. The content key is wrapped once, to that key only, never also to the network key. Reads still open secrets sealed before this change, including ones written without AAD, until they are migrated. A reader holding only one secret's key gets `legacy_envelope` / `LEGACY_ENVELOPE` for such an older copy. `secretKeyPath`, `parseSecretKeyPath` and `secretReadPermissions` build that key and the grant that reads one secret.

`vault.resealToKey(key, keyPath, { dryRun })` moves one record onto its own key: it seals a new copy, checks it opens to the same bytes, and overwrites only if the record is unchanged (`ifMatch`). Any failure keeps the old copy.

Breaking for node-sdk: `secrets.get` and `secrets.getEntry` no longer ask the wallet for missing authority. Pass `requestPermission: true` for a read the user started. Without a live grant on the secret's own key the read is `DECRYPT_DENIED` with `permissionHint` naming that key, and a node refusing that key gives the same code. `namedKeyOnly: true` opens only a copy sealed to the secret's own key. Both are on the new `SecretGetOptions`. `put`, `delete` and `list` still ask as before.

web-sdk keeps approved grants for one secret's own key across reloads, like panel grants. In web-sdk, `secrets.get` and `secrets.getEntry` with `requestPermission: true` ask the page's permission prompt for exactly that key on the space's own network, then read once more. That prompt always shows, even after "don't ask for 30 days". A declined or closed prompt returns `PERMISSION_DENIED`, and the next opted-in read asks again. Without the flag they never ask. A node-sdk node restored without a signer no longer reports that it can ask for authority.

A runtime grant on a secret's own key lasts 1 hour unless an expiry is asked, is capped at 7 days, and still ends with the session. Secret names and scopes are limited to 64 characters (`MAX_SECRET_NAME_LENGTH`, `MAX_SECRET_SCOPE_LENGTH`); a longer one is `INVALID_INPUT`. `resealToKey` throws unless `keyPath` is the record's own secret key.

`delegateTo` of a secret's key needs that key in the signed session: sign in with an explicit `capabilityRequest` that includes `<network>/secrets/` (decrypt, key.create). The default sign-in does not include it. `delegateTo` refuses any `secrets` path that is not one secret's exact key.

Details: TC-3801
