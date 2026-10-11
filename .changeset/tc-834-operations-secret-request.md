---
"@tinycloud/operations": minor
---

New operation `tinycloud.secrets.status@1`. It is read-only and never signs in: it restores the profile's stored session only, writes no profile state (no session, store, lock or migration marker), saves no authority requests, and returns `ready`, `pending` (with a Secret Manager `/request` link for the missing names, or a `tc secrets put … --stdin` hint for a local identity) or `consent_required` (with the `denied` names). It has an 18 s response deadline. Its errors carry `details.recovery`: `sign_in` with the persistent login command for the profile's posture, or `complete_migration` with `tc --profile <profile> auth caps` (`operationId: "tinycloud.auth.capabilities"`); a command is included only for a profile name that is safe in a shell command.

New exports and contracts:
- `@tinycloud/operations/secret-request`: the one Secret Manager link builder (`buildSecretRequestUrl`, `secretSetupFor`, `buildSecretManagerUrl`), the TC-832 owner/name/scope rules (`canonicalSecretRequestOwner`, `isValidSecretName`, `isValidSecretRequestScope`, `validSecretNames`), `resolveSecretsOwner`, `missingSecretRecovery`, `ownerOfSpace` and `isSafeRequestAccessRecovery`.
- `@tinycloud/operations/recovery`: `signInRecovery`, `migrationRecovery`, `isSafeRecovery`, `SAFE_PROFILE_TOKEN`.
- `isLocalOwnerProfile` from `@tinycloud/operations/profile`: the one local-owner predicate (posture `local-owner-key`, `authMethod: "local"`, or a stored `privateKey`), now shared with the CLI.
- The `"restored"` runtime requirement. The kernel dispatches the declared requirement and applies the same owner opt-in and posture checks to `"restored"` as to `"authenticated"`. `replayStoredDelegationRecords` replays stored grants without migrating; `replayProfileDelegations` is unchanged.
- `OperationDefinition.deadlineMs`, the new error code `PROFILE_MIGRATION_REQUIRED`, and the stored-grant skip reasons `activation_unavailable` and `activation_unauthenticated`.
- Error details that now survive redaction, each strictly validated: `AUTH_REQUIRED.recovery`/`reason` (`explicit_key`), `SESSION_NOT_FOUND.recovery`, `PROFILE_MIGRATION_REQUIRED.recovery`, `INPUT_INVALID.reason` (`OWNER_MISMATCH`, `OWNER_DID_UNKNOWN`) and `KV_NOT_FOUND.{names, scope, owner, recoveryKind}`. Runtime-preparation errors now pass the same allowlist as execution errors.

Breaking behavior:
- `tinycloud.secrets.get`'s `setup_required.setup` moves from the `/app?secret=…&space=…` link to the canonical `/request?owner=…&name=…&v=1` link and gains the required fields `action: "add_secret"`, `names` and `owner`; the generated result schema requires them.
- A missing secret for a local identity (including a profile with a stored `privateKey`), or one no request link can express (a legacy scope such as `scoped`, a name or scope over 64 characters, or an unknown owner), now returns error `KV_NOT_FOUND` with `details.recoveryKind` (`put_locally` or `not_requestable`) instead of `setup_required`.
- `buildSecretSetupUrl` is removed. Code that enumerates `OPERATION_ERROR_CODES`, `STORED_GRANT_SKIP_REASONS` or `OperationRuntimeRequirement` sees the new values. `generated/operations.json` gains the new operation, error code, skip reasons and setup fields.
