---
"@tinycloud/sdk-core": minor
"@tinycloud/share-sdk": patch
"@tinycloud/node-sdk": minor
"@tinycloud/cli": minor
---

Wallet-signed SIWE ReCap grants now declare their delegation mode in the top-level `xyz.tinycloud.policy/delegationMode` ReCap field (`"terminal"` or `"attenuable"`).

- Normal owner sign-in, runtime permission grants, public-space setup, and OpenKey sign-in requests declare `"attenuable"`.
- Third-party wallet-signed delegations (`delegateTo(..., { forceWalletSign: true })`, i.e. `TinyCloudNode` `createDelegationWalletPath` and its public-space companion grant) declare `"terminal"` and accept `disableSubDelegation: true`. Terminal grants are signed by the wallet signer only, never requested from OpenKey.
- The JS ReCap parsers in `@tinycloud/sdk-core` (`parseSignedSiweCacao` / `reCapAttenuation`, `extractSiweDelegationMode`, `extractRecapAttenuations`) and `@tinycloud/share-sdk` (`decodeOwnerRootCacao`) accept `"terminal"`, `"attenuable"`, or absent (legacy attenuable) and reject `null`, other values, duplicate or escaped-name JSON keys, and unknown top-level ReCap fields.
- OpenKey verification accepts an absent mode for legacy-attenuable flows and pre-upgrade OpenKey responses while refusing flipped modes and dropped declared `"terminal"` modes.
- The CLI can forward a caller-supplied `delegationMode` on `/delegate` links and device authorization requests, verifies returned modes, and surfaces plain-language refusal copy when a node refuses re-delegation of a terminal grant (`terminal-parent-cannot-redelegate`).

Details: TC-3810
