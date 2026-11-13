# @tinycloud/share-sdk

## Subpath exports

- `@tinycloud/share-sdk/web-recipient`: `inspectShare`, `ShareRecipientClient`, and the `ShareMetadata` type. The browser recipient surface, imported without the package root barrel. Its contents are fixed to these three names.

The web-recipient subpath is its own build entry, built with splitting: false, so it ships its own copies of inspectShare and ShareRecipientClient. Use the subpath's exports together, and check results by their fields rather than by class identity.

The credential witness answers browser requests only for the origins it is configured with.

openerOrigin and completionOrigin must be https origins (openerOrigin defaults to the page's own origin): web-sdk credential acquisition rejects anything else, and the witness enforces the same rule.

## Publishing an addressed share (path-bound content)

`plan.registrationPermissions` requests only the current share's exact key. The separate `pathBoundSessionPermissions` helper returns a prefix grant for first-party static sessions; third-party apps use the exact share approval flow instead.

With a TinyCloud Web client configured for OpenKey's new-share approval, start approval in the original Share click, before awaiting content or node lookups:

```ts
const approval = tcw.approveNewShare({
  expiresAt, // Date, no later than the signed session's expiry
  permissions: [{ service: "tinycloud.kv", space: "applications", path,
    actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"] }],
});
const { shareId, encryptionNetwork } = await approval;
const plan = planPathBoundShare({ shareId, encryptionNetwork });
```

This installs the exact runtime registration grant. Signed-result activation uses the WASM session-grant verifier, or the cryptographic persisted-session verifier on compatible older bindings; if neither is available, approval is refused. Continue with encryption and publication below; do not ask for `plan.registrationPermissions` again. The ordinary storage `path` can be chosen separately from the returned share id. The new OpenKey client/server support is required; older clients do not provide this method. Consumers of the exact plan must adopt this approval flow or keep their previous working SDK graph. Do not use the static prefix helper for third-party apps.

Every addressed share (a DID, an email address or an email domain) is encrypted under its own named key, `share/<shareId>` on the owner's default encryption network, and its content source registers that key and the digest of its wrapped key. The node registers and opens only that one key, never the whole network. The share-sdk owns the path, the digests and the stored bytes, so a consumer writes none of them:

```ts
import {
  bindPathBoundContentSource, defaultEncryptionNetworkForOwner, encryptAddressedShareContent,
  planPathBoundShare, publishAddressedShare,
} from "@tinycloud/share-sdk";

// 1. Plan, before anything is written. The network must be the owner's default network with the EIP-55 checksummed address.
const plan = planPathBoundShare({ shareId, encryptionNetwork: defaultEncryptionNetworkForOwner(ownerDid) });

// 2. Hold decrypt on the exact `<network>/share/<shareId>` key (`plan.registrationPermissions`):
//    the node refuses to register the share unless the owner holds it; a bare-network decrypt never covers a share key. No capability is needed to encrypt: the share's key is deterministic and
//    `keys.encrypt` wraps to its public key, which the node serves without authentication. The node records the key when the share policy
//    is registered (step 5), in the same transaction. Each published share adds one key record, which counts toward the network's key limit
//    (shared with `apps/` keys); `planPathBoundShare` refuses a bad share id or network before anything is encrypted.
//    The share id is ONE grammar everywhere (plan, size bound, publisher): `[a-z0-9][a-z0-9_-]{15,63}` (16 to 64 characters; a lowercase `randomUUID()`,
//    with or without its hyphens, is valid). Uppercase, `.`, a leading `_` or `-`, and anything longer than 64 characters are refused.

// 3. Encrypt under the share's key (`keys` is a named-key client: `tcw.keys`, `node.keys` or `NamedKeyClient`).
const encrypted = await encryptAddressedShareContent({ plan, keys, plaintext, metadata: { contentType } });

// 4. Store EXACTLY encrypted.storedBytes (the canonical v2 envelope) at the share's path.
await put(path, encrypted.storedBytes);

// 5. Bind and publish. Registering the policy records the share's key.
const contentSource = bindPathBoundContentSource({
  plan, envelope: encrypted.envelope, storedBytes: encrypted.storedBytes, kvResource: `${spaceId}/kv/${path}`, selector: "exact",
});
await publishAddressedShare({ /* shareId, target, resource, actions, ... */ contentSource, authority });
```

`publishAddressedShare` refuses a content source that is not bound to its own share's key (`AddressedContentSourceError`, match on `code`: `key-path-required`, `key-path-mismatch`, `digest-invalid`, `network-invalid`) before it signs, registers or writes anything; there is no network-wide fallback. Do not call `encryptToNetwork` with a `keyPath` for a share: it returns a v1 envelope wrapped to the network key, which neither the node nor the recipient opens. `assertAddressedShareFits` and `addressedShareBodyUpperBound` derive the key path from `shareId`. Opening an older share that has no key path is unchanged.

Hand-written content sources are not supported: the publisher checks the path, the digest's format and the network, but only `bindPathBoundContentSource` derives the raw-byte digest the recipient and the node compare.
