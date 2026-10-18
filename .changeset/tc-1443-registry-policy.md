---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Add an opt-in `registryPolicy: "fail-closed"` for host resolution and automatic space creation (TC-1443). The default does not change.

**Default (`"legacy-fallback"`, deprecated).** Sign-in resolves hosts exactly as before: when the location registry has no record or cannot be reached, the session silently uses the fallback host (`https://node.tinycloud.xyz` unless `tinycloudFallbackHosts` says otherwise). The first time a process takes that fallback it logs one `console.warn`; the fallback will be removed in a future major release. The default policy adds no registry request anywhere and no space-creation check.

**`registryPolicy: "fail-closed"`** (`TinyCloudNodeConfig`, `NodeUserAuthorizationConfig`, web `Config`):

- Sign-in without a configured host looks up the signer address in the registry and acts on the three-state verdict. `registered`: the record's hosts, in record order. `unregistered`: `newUserHost` (default `https://node.tinycloud.xyz`; `null` refuses unregistered owners with `NodeNotFoundError`). `unavailable` (unreachable, timeout, bad status, oversize or malformed body, bad signature, a sequence below the remembered one, a not-found after a registration was seen, or no registry configured): `RegistryUnavailableError`, never the new-user host. A record with no usable host is `NodeNotFoundError`.
- The lookup key is the signer address, never the session chain. The v1 registry keys records on an exact `did:pkh:eip155:<chain>:<EIP-55 address>`, so v1 lookups use `registryOwnerSubjectV1(address, registryChainId)` (`registryChainId` default 1). Registry v2 will key on the address alone.
- `onNodeNotFound({ error, attempt })` decides what sign-in does instead of throwing: `{ action: "retry" }`, `{ action: "use-host", host }` (an HTTPS or loopback HTTP origin, for this session only) or `{ action: "abort" }`.
- Automatic space creation is guarded: `ensureSpaceExists` (before asking the creation handler), account bootstrap host steps, sign-in's owned-space hosting and `ensureOwnedSpaceHosted`. Creating a space is refused with `NodeRegistryEntryExistsError` when the owner's registry record does not list the host (including a record with no hosts), and with `RegistryUnavailableError` when the registry gives no verdict. The space-creation handler's `onSpaceCreationFailed` receives the error. Pinned-host apps look the verdict up once, at creation. Explicit `hostOwnedSpace()` and `ensurePublicSpace()` calls are not guarded.
- The highest record sequence seen per owner is remembered in `registrySequenceStore` (default in memory; web-sdk defaults to `localStorage` under `tinycloud.registrySequences.v1`). A corrupt stored value fails the lookup closed.

New sdk-core exports: `resolveOwnerHosts`, `lookupOwnerRegistryVerdict`, `resolveFailClosedTinyCloudHosts`, `assertSpaceCreationAllowed`, `registryOwnerSubjectV1`, `createInMemoryRegistrySequenceStore`, `createLocalStorageRegistrySequenceStore`, the errors `NodeNotFoundError` (`code: "node_not_found"`), `RegistryUnavailableError` (`"registry_unavailable"`) and `NodeRegistryEntryExistsError` (`"node_registry_entry_exists"`), their option and callback types, and `DEFAULT_NEW_USER_HOST`, `DEFAULT_REGISTRY_OWNER_CHAIN_ID`, `DEFAULT_REGISTRY_LOOKUP_TIMEOUT_MS` (3 s) and `DEFAULT_REGISTRY_SEQUENCE_STORAGE_KEY`.
