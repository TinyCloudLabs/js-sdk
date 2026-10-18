---
"@tinycloud/share-sdk": minor
---

Add `ShareRoot` (TC-1423 D3, slice 1) under the new subpath `@tinycloud/share-sdk/share-root` (the main entry is unchanged, so its consumers' bundles do not grow): a wallet-signed, read-only root delegated to one non-extractable Ed25519 share key, so shares can outlive the owner's login session.

- `ShareRoot.create` asks the owner once through `createOwnerDelegation({ permissions })` for exactly `kv/get` + `kv/metadata` on `xyz.tinycloud.share/shares/` in the `applications` space and `encryption/decrypt` on the owner's `:share` network (`agent` roots: kv only, `default` space). It then decodes the signed CACAO and rejects anything else: other abilities or caveats, other resources, a parent, another audience or owner, a lifetime over 37 days (agents: 30), or an expiry other than the one requested. A rejected root's key is cleared and the error carries its CID for an owner revoke.
- `policyRootSigner` is the only path to sign email/domain policy roots with the share key. It throws unless the `shareRootPolicyRoots` option is on and the Node's `GET /info` `features` list `policy-owner-authority-v1` and `policy-owner-authority-enforce` (not `-record`). No released Node does yet, so addressed shares keep per-share grants. `createPolicyOwnerModeProbe` caches each Node's answer for at most 5 minutes and accepts the features a sign-in already read (`observe`); any failure counts as not enforcing.
- `signBearerLink` signs a `kv/get` link on one exact key under the prefix, outside WASM, with the share key's `sign`; it never outlives the root or 30 days.
- `ensureShareRoot` re-roots (new key, one approval) only when the requested link expiry needs more time than the current root has left.
- `signShareKeyDelegation`, `assertNonExtractableShareKey` and `decodeOwnerRootCacao` are exported for these flows.
