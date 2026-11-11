---
"@tinycloud/sdk-core": minor
"@tinycloud/cli": minor
"@tinycloud/operations": patch
---

Add `tinycloud registry publish <space...> --server <url>`, and `publishLocationRecordV2` from `@tinycloud/sdk-core/registry-publication`, to publish an account's storage settings signed by its owner. Published settings are public: anyone who knows the account ID can look up its server addresses and space names. The command shows the full result and asks before publishing, keeps spaces already published, and reports `changed: false` in JSON when nothing changed. Nothing is published at sign-in.

Details: TC-2657
