# @tinycloud/tee-verify

Checks that a TinyCloud service runs the code it says it runs, in a TEE. It verifies the service's `/attestation` response (tinycloud-node `docs/attestation.md`; OpenKey `docs/tee-overview.md`, "Public attestation") and fails closed. Every refusal says which check failed.

1. The key binding was rebuilt from your nonce and the signer you expect.
2. Intel's signature over the TDX quote, with TCB status `UpToDate` (pinned `@phala/dcap-qvl` 0.7.0, collateral from Phala's PCCS).
3. REPORTDATA is the binding digest.
4. The TD debug bit is clear.
5. The RTMR3 event log replays to the quote, and the app ID, compose hash, OS image hash and key provider are read from that replay. Only version 1 event logs are supported; an OS that writes version 2 events is refused until the replay supports them.
6. The OS image and its MRTD and RTMR0-2 are on the published production list.
7. The app ID and compose hash are a published release.
8. The keys came from that release's KMS: the `key-provider` event names its root key exactly. dstack takes keys from whatever KMS the host names unless the compose sets `key_provider_id`, and only records the one it used.

The lists are in `pins/` (see `pins/README.md`).

## Command

```sh
npx @tinycloud/tee-verify https://tee.node.tinycloud.xyz
```

It asks for a quote over a fresh random nonce and prints:

```
verified
  service:      tinycloud-node 1.26.19
  os image:     <name> (<hash>)
  app id:       <app id>
  compose hash: <compose hash>
  kms:          kms <root key, hex SPKI>
  signer:       did:key:…
  tcb:          UpToDate
```

or `refused: <reason>`. Exit 0 means verified, 1 refused, 2 a usage error. Options:

- `--signer <signer>`: the signer you expect, matched exactly. Without it, the node's `/info` `nodeId` is checked. For OpenKey, the attested `identity` (`<issuer>#<sorted RFC 7638 thumbprints>`) must list only keys that `<url>/api/auth/jwks` serves. OpenKey quotes only the keys it proves it holds, so served keys left out are printed as `unproven`: the quote does not cover tokens they sign. The response's `excluded_keys` count is outside the key binding and is not used.
- `--service openkey`: verify `https://api.openkey.so` (binding domain `so.openkey/tee-key/v1`). OpenKey has no published release yet, so it is refused.
- `--json`: machine-readable output.

## Library

```ts
import { verifyAttestation, verifyService, TeeVerifyRefused } from "@tinycloud/tee-verify";

const verified = await verifyService("https://tee.node.tinycloud.xyz", { identity: expectedDid });
// or, with a response you fetched yourself:
await verifyAttestation(response, { service: "tinycloud-node", nonce, identity: expectedDid });
```

Both throw `TeeVerifyRefused` (`code`, `message`) on any failed check.

The RTMR3 replay and the DCAP checks are adapted from the TC-2823 escrow verifier in openkey PR #491.
