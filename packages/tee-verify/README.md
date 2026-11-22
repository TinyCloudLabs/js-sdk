# @tinycloud/tee-verify

Checks that a TinyCloud service runs the code it says it runs, in a TEE. It verifies the service's `/attestation` response (tinycloud-node `docs/attestation.md`; OpenKey `docs/tee-overview.md`, "Public attestation") and fails closed. Every refusal says which check failed.

1. The key binding was rebuilt from your nonce and the signer you expect.
2. Intel's signature over the TDX quote, with TCB status `UpToDate` (pinned `@phala/dcap-qvl` 0.7.0, collateral from Phala's PCCS).
3. REPORTDATA is the binding digest.
4. The TD debug bit is clear.
5. The RTMR3 event log replays to the quote, and the app ID, compose hash, OS image hash and key provider are read from that replay. Only version 1 event logs are supported; an OS that writes version 2 events is refused until the replay supports them.
6. The OS image and its MRTD and RTMR0-2 are on the published production list.
7. The app ID and compose hash are a published release.
8. The CVM's dstack keys came from that release's KMS: the `key-provider` event names its root key exactly. dstack takes keys from whatever KMS the host names unless the compose sets `key_provider_id`, and only records the one it used.

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

- `--signer <signer>`: the signer you expect, matched exactly. Without it, the node's `/info` `nodeId` is checked.
- `--service openkey`: verify `https://api.openkey.so` (binding domain `so.openkey/tee-key/v1`). Its attested `identity` (`<issuer>#<sorted RFC 7638 thumbprints>`) must list only keys that `<url>/api/auth/jwks` serves, and **every** key it serves. A served key the quote does not cover is refused (`unattested-keys`), because relying parties that trust `/jwks` would accept tokens it signs. A positive `excluded_keys` also refuses; otherwise that count is not used, as it is outside the key binding. OpenKey keeps its signing keys in its database, not in the TEE, so a pass proves the measured code holds those keys, not that no other system does (openkey#706, `docs/tee-overview.md`); the command prints this as a warning. OpenKey has no published release yet, so it is refused.
- `--allow-unattested-keys` (OpenKey only): report served keys the quote does not cover as a warning instead of refusing. Use it only to diagnose a key rotation, never to trust tokens.
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
