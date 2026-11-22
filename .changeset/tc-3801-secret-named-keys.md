---
"@tinycloud/sdk-services": minor
"@tinycloud/node-sdk": minor
---

Each secret is sealed to its own key, `secrets/<name>` (or `secrets/scoped/<scope>/<name>`), so one secret can be shared without the others. Reads still open secrets sealed before this change. A reader holding only one secret's key gets `legacy_envelope` / `LEGACY_ENVELOPE` for such an older copy. `secretKeyPath` and `secretReadPermissions` build that key and the grant that reads one secret.

Details: TC-3801
