---
"@tinycloud/cli": patch
---

`builtin:share-publishing` now also asks for decrypt on the account's own default key when signing in with `--paste`, so that profile can create email-addressed shares. `--device` sign-in and `enable share` still request it without that entry; an email share from a device sign-in says to run `tc auth login --paste --manifest builtin:share-publishing`.

Details: TC-2177
