---
"@tinycloud/cli": patch
---

`tc auth login` (`--device`, `--paste` and browser) and `tc init` now wait for OpenKey to host the account's space before reporting success (TC-1608). OpenKey hands the CLI its delegation while it is still hosting the space in the background, so the first storage command could fail with `404 Space not found`. When OpenKey reports `spacePending`, the login shows "Setting up your space…" and re-reads the space with the saved session (read-only, no new signature, ability or delegation) for up to 150 seconds. A `spaceError` from OpenKey now fails the login with `SPACE_SETUP_FAILED` and OpenKey's error text and code, and a timeout fails with `SPACE_SETUP_PENDING`; both exit 1 and keep the saved session, so retrying or approving again in OpenKey re-runs the setup. `spaceReady: false` alone (OpenKey will not host it) and a session with no kv grant to read with print a warning. Logins whose delegation says nothing about the space, or says it is ready, do not wait.

An OpenKey profile's `SPACE_NOT_HOSTED` error no longer tells you to run `tc space host`, which cannot work without a signer. It says: "OpenKey is still setting up your space. Wait a minute and retry; approving again in OpenKey re-runs the setup." Local-key owners keep the `tc space host` hint.
