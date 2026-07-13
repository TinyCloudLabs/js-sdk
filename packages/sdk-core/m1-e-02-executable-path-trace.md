# m1-e-02 executable-path trace

Status: constructible. Claims below are **confirmed from code** at prepared base
`040603a` unless explicitly identified as an observation to be added. This is a
client-SDK trace: a schema-true `/delegate` receipt permits the client to proceed;
it does not prove node acceptance, indexing, persistence, or enforcement.

## Runtime and ordering

1. The caller obtains a schema-v1 bootstrap before constructing
   `TranscriptRequester` (`src/requester/index.ts:315-348, 459-490`). The additive
   owner-node URL is an untrusted routing hint. Construction rejects unsupported
   schemes, credentials, fragments, private/link-local/loopback DNS answers, or
   missing transport resolution metadata. The validated origin and resolved
   public addresses are pinned for the requester lifetime; every response must
   report matching final URL/address metadata, so redirects, endpoint changes,
   and DNS rebinding fail closed.
2. Reads call `ensureFreshDelegation` first (`src/requester/index.ts:516-581`). If
   renewal is needed, challenge and resolve remain ordered and retain their
   existing retry/denial behavior (`:583-702`, `:1080-1095`).
3. Resolve supplies the already node-native compact-JWS string in
   `delegation.encoded`; import validates the envelope (`:705-750`) and then POSTs
   those exact string bytes as `Authorization` to `<owner origin>/delegate`.
   Existing production submission is `submitHostDelegation` /
   `activateSessionWithHost` (`src/space.ts:60-117`); its response surface will be
   extended to preserve `cid`, labeled commit-event ID.
4. Only an HTTP-200 receipt with the target space in `activated` and absent from
   `skipped` confirms client-side import. Malformed, missing, skipped,
   contradictory, redirected, endpoint-changed, or transport-metadata-free
   responses fail closed before any invocation.
5. Delegation identity is derived locally from the exact decoded compact-JWS
   bytes: CIDv1 raw (`0x55`) over BLAKE3-256. The receipt commit-event ID is never
   used as delegation identity. The locally derived CID is stored only after
   receipt acceptance.
6. SQL and KV reads then use the injected holder `InvokeFunction`, with the same
   Ed25519 holder DID used by presentation signing, and the local CID as the sole
   proof parent. Existing production service machinery constructs `/invoke`:
   `DelegatedAccess` initializes `ServiceContext` with the invocation signer and
   service session (`packages/node-sdk/src/DelegatedAccess.ts:49-100`);
   `KVService.get` and SQL named-statement execution are exported from sdk-core
   and use the registry actions `tinycloud.kv/get` and `tinycloud.sql/read`.
7. Node read failures are parsed as node-native failures and never pass through
   `errorForDenial`; policy-engine challenge/resolve denials continue through
   `errorForDenial` and preserve the access-ended latch
   (`src/requester/index.ts:613-617, 1080-1095`).

Startup/state dependency: the bootstrap, holder presentation signer, holder
invocation signer, and transport DNS/final-response metadata must all be supplied
before `TranscriptRequester.create`. Imported delegation state is in-memory and
becomes readable only after receipt acceptance. Process dependency is strictly
policy engine challenge -> policy engine resolve -> owner-node delegate ->
owner-node invoke; no engine read route remains.

## Owner wallet delegation entry point

`TinyCloudNode` already loads the non-interactive `PrivateKeySigner` from
`TinyCloudNode({ privateKey })` and session/account bootstrap before delegation.
`createRootDelegationForSharing` (`packages/node-sdk/src/TinyCloudNode.ts:2624-2700`)
already calls `prepareSession({ delegateUri })`, wallet `signMessage`,
`completeSessionSetup`, and `/delegate`. The implementation will parameterize
that path into a thin public method taking caller DID, bounded capabilities, and
explicit expiry (at most `EXPIRY.MAX_MS`, `packages/sdk-core/src/expiry.ts:74-82`).
It returns exact signed bytes, locally derived CID, and raw receipt (`cid` labeled
commit-event ID). It remains wallet-rooted, non-terminal, and does not use
`delegateTo`'s session-rooted expiry cap.

## Acceptance observations

| Required fact | Observation |
| --- | --- |
| Bootstrap exact/unknown-field quarantine and URL/SSRF policy | requester schema tests exercise scheme, credentials, redirects, endpoint changes, DNS rebinding, all private IPv4/IPv6 classes, and missing metadata |
| Wallet-rooted external-DID delegation | node-sdk test spies on the existing WASM `prepareSession`/completion path and frozen-shaped `/delegate` receipt; asserts caller DID, bounds, non-terminal mode, explicit expiry, returned bytes/local CID/raw commit-event ID |
| Native resolve payload and byte equality | requester test loads only frozen `resolve-happy-native.json`, observes exact `Authorization` string at `/delegate`, and asserts no serialization/conversion |
| Independent CID oracle | requester test loads frozen `grant-output-vendored/accept.json`, independently base64url-decodes the compact JWS, hashes exact bytes with BLAKE3, constructs CID bytes, and compares the frozen deterministic identity and parent formatting |
| Receipt validation and sequencing | table test supplies schema-true and malformed frozen-shaped responses and observes zero `/invoke` calls until accepted |
| Sole proof parent and correct actions | SQL and KV tests inspect holder signer inputs: one local derived CID parent and exact `tinycloud.sql/read` / `tinycloud.kv/get` registry abilities |
| Same holder identity | construction/read tests reject missing invocation signer or signer DID unequal to presentation holder DID with typed errors |
| Error claim discipline | paired tests show node `UnauthorizedAction` / expired-parent errors retain node classification while resolve `policy-inactive` retains engine denial code and access-ended latch |
| Happy-path bytes | SQL and KV response fixtures pass byte-equivalent values through requester public methods |

## Unsupported hops

None inside amendment 37's client-SDK scope. Real node acceptance, indexing,
persistence, and enforcement are deliberately unsupported observations here and
belong to m1-g-08 / m1-g-05b-r1; no test or product error will claim them.

