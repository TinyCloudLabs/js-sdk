---
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Add `DelegateToOptions.onPrepared` so callers can durably record a grant before it goes live (TC-839). `delegateTo` calls `onPrepared(delegation)` with the exact `PortableDelegation` it then returns as `result.delegation` (CID included), after signing and before host activation, on both the session-key and runtime-grant paths. If the hook rejects, no `/delegate` activation request is sent and `delegateTo` rejects with that same error. Passing `onPrepared` together with `forceWalletSign: true` throws before anything is signed, because the wallet path activates as part of signing. `TinyCloudWeb.delegateTo` passes the option through unchanged. Calls without `onPrepared` behave as before.
