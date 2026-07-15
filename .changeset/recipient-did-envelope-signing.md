---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/sdk-rs": minor
"@tinycloud/node-sdk-wasm": minor
"@tinycloud/web-sdk-wasm": minor
---

Add the fixed-purpose recipient-DID share-envelope v2 signing and owner-proof
export operation. Node and browser runtimes now expose the atomic, network-free
native delegation-bundle verifier and continue to fail closed for custom or
older WASM bindings that do not implement it. Recipient signatures use strict
RFC8032 Ed25519 verification, and share expiry is normalized to whole seconds.

Publishing is gated on the first tinycloud-node release tag after v1.4.5 that
contains the recipient-DID verifier and exact typed WASM declaration. That tag
must replace both Rust dependency pins before regenerating and publishing the
Node/browser WASM packages currently consumed at version 1.7.4.
