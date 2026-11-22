# Published lists

The verifier trusts only these files. They are bundled into the build, and nothing at runtime can add to them. A change is a reviewed pull request that says where each value came from.

## `os-images.json`

- `production`: dstack OS images a service may run, each as one VM shape measures it: `osImageHash` (the `os-image-hash` event in RTMR3), `mrtd`, `rtmr0`, `rtmr1` and `rtmr2`, all lowercase hex. RTMR0 covers the virtual hardware (vCPUs, memory), so one image can have several entries. Add an entry from a verified quote of a production-OS CVM, or from `dstack-mr` run on the released image with the CVM's shape. Name the source in the pull request.
- `refused`: known non-production images. They are listed only so the refusal can name the image; an image missing from `production` is refused either way.

The list is empty today. The node runs `dstack-dev-0.5.15` until its move to the production OS (TC-3838), and OpenKey has no public attestation route until TC-3842. Until an entry lands, every service is refused at the OS check.

## `releases.json`

The released versions of each service: `service`, `version`, dstack `appId` and `composeHash` (SHA-256 of the deployed `app-compose.json`). Take each new entry from the release's published `app-compose.json` and its hash (TC-3839). `1.26.19` was taken from the node's attestation on 2026-11-22 (`../test/fixtures/README.md`).
