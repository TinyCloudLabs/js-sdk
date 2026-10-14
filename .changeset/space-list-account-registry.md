---
"@tinycloud/cli": patch
---

`tc space list` no longer fails with `AUTH_REQUIRED` (exit 3) on sessions that lack `tinycloud.space/list`, which no OpenKey or local-key sign-in requests (TC-1083). It now lists the owner's spaces from the account registry (`account/spaces/`) when the session holds `tinycloud.kv/get` and `tinycloud.kv/list` on the account space's `spaces/` prefix, as local-key owner sessions do, and uses `tinycloud.space/list` only when the session holds it. The JSON output keeps `spaces` and `count`; registry entries carry `id`, `name`, `owner`, `type`, `permissions` and `status`.

A session with neither, such as a default OpenKey owner sign-in (which covers only the `default` space), now fails with `PERMISSION_DENIED` (exit 5) naming both capabilities, instead of a 401 that read as "not authenticated". Owners get the registry read with `tc auth request --grant --cap tinycloud.kv:account:spaces/:get,list`; delegates are told to request it from the owner.
