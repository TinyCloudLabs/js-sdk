# @tinycloud/tee-verify

Checks that a TinyCloud service runs the code it says it runs, in a TEE. It verifies the service's `/attestation` response (tinycloud-node `docs/attestation.md`) and fails closed. Every refusal says which check failed.

1. The key binding was rebuilt from your nonce and the signer you expect.
2. Intel's signature over the TDX quote, with TCB status `UpToDate` (pinned `@phala/dcap-qvl` 0.7.0, collateral from Phala's PCCS).
3. REPORTDATA is the binding digest.
4. The TD debug bit is clear.
5. The RTMR3 event log replays to the quote, and the app ID, compose hash and OS image hash are read from that replay.
6. The OS image and its MRTD and RTMR0-2 are on the published production list.
7. The app ID and compose hash are a published release.

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
  signer:       did:key:…
  tcb:          UpToDate
```

or `refused: <reason>`. Exit 0 means verified, 1 refused, 2 a usage error. Options:

- `--did <did>`: the signer you expect. Without it, the `nodeId` that `/info` names is checked.
- `--service openkey`: refused until OpenKey's route shape is pinned (TC-3842).
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
