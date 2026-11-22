# Published lists

The verifier trusts only these files. They are bundled into the build, and nothing at runtime can add to them. A change is a reviewed pull request that says where each value came from.

## `os-images.json`

- `production`: dstack OS images a service may run, each as one VM shape measures it: `osImageHash` (the `os-image-hash` event in RTMR3), `mrtd`, `rtmr0`, `rtmr1` and `rtmr2`, all lowercase hex. RTMR0 covers the virtual hardware (vCPUs, memory), so one image can have several entries. Add an entry from a verified quote of a production-OS CVM, or from `dstack-mr` run on the released image with the CVM's shape. Name the source in the pull request.
- `refused`: known non-production images. They are listed only so the refusal can name the image; an image missing from `production` is refused either way.

The list is empty today. The node runs `dstack-dev-0.5.15` until its move to the production OS (TC-3838), and OpenKey has no public attestation route until TC-3842. Until an entry lands, every service is refused at the OS check.

## `releases.json`

The released versions of each service: `service`, `version`, dstack `appId` and `composeHash` (SHA-256 of the deployed `app-compose.json`), and the KMS the release takes its keys from: `keyProviderName` and `keyProviderId` (hex DER SPKI of the KMS root key), which must equal the `key-provider` event's `{"name":…,"id":…}` byte for byte. Take each new entry from the release's published `app-compose.json` and its hash (TC-3839), and the KMS root key from Phala's KMS list (`ca_pubkey` in `phala api /kms`).

`1.26.19` was taken from the node's attestation on 2026-11-22 (`../test/fixtures/README.md`). Its KMS is Phala's `phala` KMS (`kc_aOwADKBd`). Amos read its `ca_pubkey` from `phala api /kms` on 2026-11-22 at 13:30Z, and it equals the quote's `key-provider` id. That is Phala's word, independent of the quote. The node's compose does not set `key_provider_id`, so dstack itself would accept another KMS (TC-3835 WS2).
