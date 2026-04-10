---
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-services": patch
---

fix(node-sdk): activate WASM-path delegations with the host so downstream consumers can reference the parent CID

`createDelegationViaWasmPath` (the session-key UCAN fast path used by
`tcw.delegateTo` when the requested capabilities are derivable from the
current session) was building the UCAN client-side and returning it
directly without posting it to the host. This meant the host's delegation
store never saw the UCAN.

When a downstream consumer (e.g. a backend calling `node.useDelegation`)
tried to reference the UCAN's CID as the parent of its own invoker SIWE,
the host's chain-validation step failed with "Cannot find parent
delegation" — the host looks up parents by CID in its local database,
and the client-side-only UCAN was never stored.

Fix: after computing the UCAN in `createDelegationViaWasmPath`, call
`activateSessionWithHost` to POST the delegation header to `/delegate`
before returning the `PortableDelegation`. This mirrors the legacy
`createDelegationWalletPath` which has done the same for wallet-signed
SIWE delegations since day one.
