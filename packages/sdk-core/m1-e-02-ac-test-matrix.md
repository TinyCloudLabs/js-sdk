# m1-e-02 acceptance-to-test matrix

| Mandatory AC | Production surface | Conformance observation |
| --- | --- | --- |
| 1. Node-native resolve output | `requester/index.ts` compact-JWS schema and capability extraction | `submits the producer-derived node-native resolve bytes exactly…` consumes frozen `resolve-happy-native.json`; deprecated `resolve-happy.json` is absent |
| 2. Resolve-to-delegate byte equality | `/delegate` request uses `delegation.encoded` directly | Same test asserts exact `Authorization` equality |
| 3. Local CID is sole first proof parent | `deriveDelegationCid`; `ServiceSession.delegationCid` | Frozen oracle test plus native-flow invocation-header assertion |
| 4. Same holder identity | `RequesterInvocationCapability` identity gate | `requires the same holder invocation identity…` covers missing and mismatched signers |
| 5. Wallet-root owner delegation | `TinyCloudNode.createOwnerDelegation` | `public owner delegation is wallet-rooted…` asserts caller DID, no parents, bounded action, explicit expiry, and non-terminal/subdelegable result |
| 6. Receipt CID claim boundary | `commitEventCid` naming in `SpaceHostResult` and owner receipt | Owner-delegation test keeps commit-event CID distinct from local delegation CID |
| 7. No read without confirmed import | strict delegate receipt parser and sequencing | `fails closed before invoke for every non-confirming delegation receipt` covers non-200, missing, skipped, contradictory, and malformed receipts |
| 8. Endpoint policy | bootstrap schema plus resolved-address pinning and response metadata checks | `rejects unsafe endpoints…` covers scheme, credentials, missing resolver/response metadata, private IPv4/IPv6, redirect, and rebinding |
| 9. Correct SQL/KV abilities | holder `InvokeFunction` calls use `tinycloud.sql/read` and `tinycloud.kv/get` | `mints a fresh…performs SQL and KV reads` asserts both exact actions, no SQL write action, and the shared sole parent |
| 10. Native vs engine denial classes | `parseNodeDataResponse` is separate from `errorForDenial` | `maps server-side denial, unreachable, and policy-inactive renewal distinctly` preserves node denial/unreachable and engine access-ended semantics |

Supporting contract tests cover exact-key bootstrap quarantine, owner endpoint
composition, native happy-path SQL/KV response bytes, renewal timing, capability
containment, and the unchanged policy denial matrix.
