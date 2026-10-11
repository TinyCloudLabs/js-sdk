---
"@tinycloud/cli": minor
---

New `tc secrets request <NAME...> [--scope S | --app ID] [--owner DID] [--requester LABEL] [--open]`: prints the owner's Secret Manager `/request` link as `{url, names, scope?, owner}` and exits 0, offline. A local identity (local-owner profile, a profile holding a `privateKey`, `--private-key` or `TC_PRIVATE_KEY`) gets `LOCAL_OWNER_PROFILE` (exit 2); an unknown owner is `OWNER_DID_UNKNOWN` (exit 3).

New `tc secrets wait <NAME...> [--scope S | --app ID] [--owner DID] [--timeout D]`: polls until the secrets exist, each check in a child process killed if it overruns, bounded at timeout + 21 s (`--timeout 0` checks once). It never signs in: it needs a stored session, and `TC_PRIVATE_KEY` is not supported (exit 3). It writes no profile state and saves no consent. Exit 8 (`PENDING`) when the deadline passes with names still missing, 130 (`CANCELLED`) when interrupted, 1 for `PROFILE_MIGRATION_REQUIRED` (run `tc --profile P auth caps` once after an upgrade) or `PROBE_FAILED`.

New `--app ID` on `request`, `wait` and `manage` derives the scope with `appSecretScope`. `tc secrets manage [NAME...] [--scope S | --app ID] [--no-open]` opens the Secret Manager at the named secrets.

Error JSON gains three validated, value-free fields: `error.setup` (`{url, names, scope?, owner, action: "add_secret"}`, on `NOT_FOUND` and on `wait`'s `PERMISSION_DENIED`), `error.recovery` (`sign_in`, `complete_migration` or `request_access`, exact shapes only) and `error.progress` (`{present, pending}`, on `wait`'s `NETWORK_ERROR`/`CANCELLED`).

Fixes: `tc secrets get --delegation` now reports a missing secret with the owner's request link (never for a local identity), and a refused delegated read (403, a capability 401, `AUTH_UNAUTHORIZED`) exits 5 instead of 1. Manifest secrets resolve the owner with the shared rule (a delegate session's space owner counts; a `--owner` that disagrees with the profile's owner is `OWNER_MISMATCH`, exit 2).

**Breaks:** `tc secrets manage` JSON is now `{url, opened}` (was `{opened: url}`), and it takes optional names. Refused `tc secrets put` / `tc vault put` writes exit 3 or 5 instead of 1. `tc secrets doctor` hints for a missing secret now name `tc secrets request NAME`, or `tc secrets put NAME --stdin` for a local identity. A missing secret on `tc secrets get` now carries `error.setup` with a `/request?owner=…` link instead of an `/app` hint, and a local identity gets no link.
