# @tinycloud/share-sdk

## Subpath exports

- `@tinycloud/share-sdk/web-recipient`: `inspectShare`, `ShareRecipientClient`, and the `ShareMetadata` type. The browser recipient surface, imported without the package root barrel. Its contents are fixed to these three names.

The web-recipient subpath is its own build entry, built with splitting: false, so it ships its own copies of inspectShare and ShareRecipientClient. Use the subpath's exports together, and check results by their fields rather than by class identity.

The credential witness answers browser requests only for the origins it is configured with.

openerOrigin and completionOrigin must be https origins (openerOrigin defaults to the page's own origin): web-sdk credential acquisition rejects anything else, and the witness enforces the same rule.

## Publishing an addressed share (path-bound content)

Every addressed share (a DID, an email address or an email domain) is encrypted under its own named key, `share/<shareId>` on the owner's default encryption network, and its content source registers that key and the digest of its wrapped key. The node registers and opens only that one key, never the whole network. The share-sdk owns the path, the digests and the stored bytes, so a consumer writes none of them:

```ts
import {
  bindPathBoundContentSource, defaultEncryptionNetworkForOwner, encryptAddressedShareContent,
  planPathBoundShare, publishAddressedShare,
} from "@tinycloud/share-sdk";

// 1. Plan, before anything is written. The network must be the owner's default network with the EIP-55 checksummed address.
const plan = planPathBoundShare({ shareId, encryptionNetwork: defaultEncryptionNetworkForOwner(ownerDid) });

// 2. Hold the key-create capability for this one key (a runtime request: a manifest cannot carry it), e.g.
//    await tcw.requestPermissions(plan.requiredPermissions);
//    The session also needs `plan.registrationPermissions` (decrypt under `<network>/share/`).

// 3. Create the key and encrypt under it (`keys` is a named-key client: `tcw.keys`, `node.keys` or `NamedKeyClient`).
const encrypted = await encryptAddressedShareContent({ plan, keys, plaintext, metadata: { contentType } });

// 4. Store EXACTLY encrypted.storedBytes (the canonical v2 envelope) at the share's path.
await put(path, encrypted.storedBytes);

// 5. Bind and publish.
const contentSource = bindPathBoundContentSource({
  plan, envelope: encrypted.envelope, storedBytes: encrypted.storedBytes, kvResource: `${spaceId}/kv/${path}`, selector: "exact",
});
await publishAddressedShare({ /* shareId, target, resource, actions, ... */ contentSource, authority });
```

`publishAddressedShare` refuses a content source that is not bound to its own share's key (`AddressedContentSourceError`, match on `code`: `key-path-required`, `key-path-mismatch`, `digest-invalid`, `network-invalid`) before it signs, registers or writes anything; there is no network-wide fallback. Do not call `encryptToNetwork` with a `keyPath` for a share: it returns a v1 envelope wrapped to the network key, which neither the node nor the recipient opens. `assertAddressedShareFits` and `addressedShareBodyUpperBound` derive the key path from `shareId`. Opening an older share that has no key path is unchanged.
