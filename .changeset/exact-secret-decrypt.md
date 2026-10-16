---
"@tinycloud/sdk-services": patch
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/operations": patch
"@tinycloud/cli": patch
"@tinycloud/server": patch
---

Bind named-secret decrypt grants to an exact owner space and stored KV key. Sign the locator in the decrypt request body, produce a location-bound envelope tag, and use typed network-root-to-secret attenuation without allowing sibling scopes. CLI and operation manifests request exact decrypt authority; legacy network grants remain explicitly broad, and untagged named secrets require an owner rewrite before scoped reads.
