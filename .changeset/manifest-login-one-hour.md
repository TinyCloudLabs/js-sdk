---
"@tinycloud/cli": minor
---

`tinycloud auth login --manifest FILE` without `--expiry` now asks OpenKey for a one-hour session instead of seven days. `builtin:share-publishing` still asks for seven days, because every Share link it publishes ends when that session ends. An explicit `--expiry` overrides both, and `--device` login is unchanged (default 30 days).

What changes for existing users: a manifest login that omits `--expiry` now ends after an hour; re-running it on a profile whose live session lasts longer refuses with `SESSION_IN_USE` unless `--replace-session` is given.

The guide, skill and error hints now show the approval link (`auth login --manifest builtin:share-publishing`, which needs no code to paste back) instead of `--device --expiry 7d` or `--paste --expiry 30d`.

Details: TC-2997
