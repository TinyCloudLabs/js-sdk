---
"@tinycloud/node-sdk": minor
---

`siweRuntimeDelegation` projects OpenKey's signed-login (SIWE/ReCap CACAO) delegation from the existing wallet-signed session-grant verifier. The runtime re-verifies its `siweProof` on activation and replay, binds the signer to the session owner and the signed ReCap to that owner's space, and installs only verified permissions. The existing `activateValidatedRuntimeDelegation` callback can refuse signed capabilities before installation. Compact UCAN delegations retain their existing verification path.
