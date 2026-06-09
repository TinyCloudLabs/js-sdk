---
"@tinycloud/sdk-services": patch
"@tinycloud/node-sdk": patch
"@tinycloud/cli": patch
"@tinycloud/node-sdk-wasm": patch
"@tinycloud/web-sdk-wasm": patch
---

Accept equivalent `did:pkh:eip155` owner DID address casing when validating encryption network descriptors, including legacy `principal` descriptors, so `tc secrets` can read existing network metadata. Pin the Rust WASM source to the released `tinycloud-node` `v1.4.2` tag.
