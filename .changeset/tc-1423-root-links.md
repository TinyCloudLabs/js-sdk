---
"@tinycloud/share-sdk": minor
---

Add bearer links via the share root to `@tinycloud/share-sdk/share-root` (TC-1423 D3, slice 3). The main entry is unchanged.

- `publishRootBearerLink({ root, path, expiresAt, viewerOrigin })` mints a view-only link with no owner approval: the share key signs `kv/get` on one exact key under `xyz.tinycloud.share/shares/` (never beyond the root, never more than 30 days, exactly the requested expiry to the second), the Node imports it, and the link is encoded exactly like today's SharingService links (`/viewer#tc1=<token>`, the token carrying a fresh per-link key and its delegation), so the viewer and `openNativeShare` open it unchanged. A kv-only root is enough. Use `ensureShareRoot` first; a re-root costs one approval.
- `revokeRootBearerLink({ root, delegationCid })` revokes one link with the share key that issued it (no approval) and accepts only a matching `{ revoked: true, cid }` receipt; the owner can revoke the same CID with an owner SIWE (one approval). `ShareRoot.signLinkRevocation` signs that request and refuses the root's own CID.
- New error code `node-refused` for a Node refusing a link delegation or revocation (for example after the root was revoked: re-root).
- `ShareGrant` docs now state that its decrypt covers every object on the owner's `:share` network, bounded only by which ciphertext the holder can obtain. `ensureShareNetwork` reads Node answers through the capped JSON reader.
