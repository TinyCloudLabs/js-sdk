---
"@tinycloud/cli": patch
---

Delegate-mode secrets commands now honor `TC_PRIVATE_KEY` / `--private-key` for headless auth. Previously `tc secrets get --delegation` (and the other `--private-key`-advertising secrets commands) threw `AUTH_REQUIRED` when only an explicit private key was supplied, because `ensureAuthenticated` consulted `options.privateKey` only after its profile/session gate. An explicitly provided private key is now treated as a first-class headless identity and accepted before that gate, so a delegate can authenticate with no persisted profile and no login session — exactly what the flags and env var already advertised.
