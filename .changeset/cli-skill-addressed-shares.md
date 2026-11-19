---
"@tinycloud/cli": patch
---

The `tinycloud-cli` skill now says that `--to did:` and `--to domain:` create addressed shares. It no longer says that sharing to a domain or DID is unavailable. `--to email:` is still refused with `UNAVAILABLE`, and the skill now points the owner to share.tinycloud.xyz for one email address. The publish examples that used `--to email:` now use `--to domain:`.

Details: TC-2929
