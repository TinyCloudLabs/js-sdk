---
"@tinycloud/cli": patch
---

In an app manifest (one with `app_id`), a `tinycloud.encryption` entry no longer gets the app's path prefix, as in the SDK's own manifests: an encryption entry names a network, not a path in a space. Its network is the entry's own `space`, else the manifest's. So `{"service":"tinycloud.encryption","space":"default","path":"","actions":["decrypt"]}` now means decrypt on your own `default` network without `skipPrefix: true`, both for `tinycloud auth login --device` (which refused it with `DEVICE_AUTH_UNSUPPORTED_SCOPE`) and for browser and paste sign-in (which turned it into an unusable decrypt under the app's path).

`--device` still asks only for that one encryption entry. An encryption entry naming another network is now refused even when the manifest's top-level `space` is `default` (before, the entry's own `space` was ignored). The `DEVICE_AUTH_UNSUPPORTED_SCOPE` message now says what `--device` allows and what the manifest or request asked for.

Details: TC-2550
