---
"@tinycloud/share-sdk": minor
---

Add the owner's `:share` network and per-share grants to `@tinycloud/share-sdk/share-root` (TC-1423 D3, slice 2). The main entry is unchanged.

- `ensureShareNetwork` makes sure the owner-owned `urn:tinycloud:encryption:<owner did:pkh>:share` network exists (`shareNetworkIdFor` names it). When it exists, nothing is signed. Otherwise the owner approves one 10-minute CACAO granting only `network.create` on that URN to a throwaway non-extractable key, which creates the network with the owner as owner and is then cleared. The signed grant is decoded and must match exactly. Share and per-share keys never own a network.
- `ShareGrant.create` asks the owner for one approval per addressed (email/domain) or edit share: a CACAO to a fresh non-extractable per-share key granting kv `get` + `metadata` (+ `put` for `edit`) on exactly one key under `xyz.tinycloud.share/shares/`, plus `decrypt` on the owner's `:share` network (a Policy/v3 owner must hold decrypt on the source's network), for at most 30 days. Broader paths, longer expiries, other spaces or access levels are refused before the wallet prompt; the signed CACAO is decoded and must match exactly, or the key is cleared and the error carries the CID with `mustRevoke`.
- `ShareGrant.publishAuthority(registerPolicy)` is the `publishAddressedShare` authority for that one share: policy roots owned by the per-share key, no later than the grant, naming only its exact key (no action the grant lacks) and `:share` decrypt; 32-byte digests only. `restore` rebuilds a grant from a CLI-held key; no browser persistence.
- The owner revokes one share by revoking its grant (one approval); other shares are untouched. Until the Node binds policy registrations to the owner delegation, an already-registered policy keeps admitting recipients until its own expiry, which never exceeds the grant's.
- Wording: a `kv` share root's key cannot own a policy over `:share`-encrypted content (the Node answers `policy-owner-not-authorized`).
