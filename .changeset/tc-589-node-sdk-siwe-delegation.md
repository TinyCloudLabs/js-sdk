---
"@tinycloud/node-sdk": minor
---

`activateValidatedRuntimeDelegation` now activates a signed-login (SIWE/ReCap CACAO) delegation, such as an OpenKey approval, when it carries the new `siweProof` field. The SIWE is verified in WASM by the same verifier `restoreSession` uses (wallet signature, audience equal to this session key, validity window, ReCap binding, and authorization bytes and CID equal to the CACAO built from it), and audience, expiry and capabilities come from it. The proof is kept on the installed delegation, so a stored delegation can replay after restart. A new `authorize` option sees the signed capabilities before anything is activated and can refuse the delegation. New exports: `siweRuntimeDelegation`, which projects such a delegation from its verified SIWE, `TinyCloudNode.verifySiweDelegation`, and their types. Compact UCAN delegations are handled exactly as before.
