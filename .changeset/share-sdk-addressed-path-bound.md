---
"@tinycloud/share-sdk": patch
---

Addressed shares are path-bound. New `planPathBoundShare`, `encryptAddressedShareContent`, `bindPathBoundContentSource` (with `pathBoundStoredBytes`, `pathBoundKeyPath`, `wrappedKeyDigestHex`, `defaultEncryptionNetworkForOwner`) build the content source for a share encrypted under its own named key `share/<shareId>`: the key path, the raw-byte wrapped-key digest and the exact bytes to store are derived in one place. `publishAddressedShare` now requires that source and refuses anything else (`AddressedContentSourceError`: `key-path-required`, `key-path-mismatch`, `digest-invalid`, `network-invalid`) before it signs, registers or writes; the network-wide decrypt fallback is gone, so the recipient's only decrypt capability is `<network>/share/<shareId>`. `assertAddressedShareFits` and `addressedShareBodyUpperBound` derive the key path from `shareId`. Opening existing shares, with or without a key path, is unchanged.

Details: TC-2242
