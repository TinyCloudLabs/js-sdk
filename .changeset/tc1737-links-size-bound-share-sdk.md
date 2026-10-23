---
"@tinycloud/share-sdk": minor
---

A sender can measure an addressed share against the link size limit before it writes anything.

- `addressedShareBodyUpperBound(input)` returns the largest sealed envelope the share can have, in bytes. It builds the envelope through the same serializer as `publishAddressedShare`, from the share's own inputs, with every value a write returns (root and registration identifiers, owner root authorizations, the enforcer's attestation, signatures, artifact version and digests) at its maximum encoded length, and seals it with a throwaway key. `assertAddressedShareFits(input)` throws a `SharePublishError` (`max-bytes-exceeded`, `ADDRESSED_SHARE_TOO_LARGE_MESSAGE`) when that is over `MAX_LINK_BODY_BYTES`.
- `publishAddressedShare` runs the same check before its first write and fails with that `SharePublishError`. It then measures the sealed envelope itself before it builds a link; if that is over the limit it throws `AddressedShareOverLimitError`, whose `written` names the policy and the two owner roots it registered so the caller can remove them. No link is built.

Do not release before the deploy window for the links API, witness, node, Share web and CLI.

Details: TC-1737
