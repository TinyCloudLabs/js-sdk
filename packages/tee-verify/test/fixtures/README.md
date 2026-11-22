# Fixtures

## `node-dev-os-attestation.json`

The public `GET https://tee.node.tinycloud.xyz/attestation?nonce=ad9077d2ad7b1ee0df0cf481f13ecffa` response, byte for byte, recorded 2026-11-22T13:13:10Z. That day the node ran 1.26.19 on `dstack-dev-0.5.15` (os-image-hash `432b8a1e…`): app `350d124c…`, compose hash `1dc2fe4a…`, signer `did:key:z6MkjHi79SMX4doJyo2w7jDTM6Fa7iX6EVZWXNbJ6RzBm3Wi` (the `/info` `nodeId`).

It contains only public data: the TDX quote, the dstack event log, the app ID, the compose hash and the node's public DID. It is the fixed "dev image refused" case. Its MRTD and RTMR0-2 appear in the test's test-only trust list, so the checks after the OS one also run on a real quote.

## `node-dev-os-collateral.json`

Intel collateral for that quote, fetched from `https://pccs.phala.network` on 2026-11-22. It is public and Intel-signed: `verify` checks its signatures against Intel's root, and it is valid until 2026-12-22. The tests verify at 2026-11-22T13:16:00Z, so they don't depend on the wall clock or the network.

## `upstream/`

`tdx_quote` and `tdx_quote_collateral.json`, copied byte for byte from Phala-Network/dcap-qvl tag v0.7.0, `sample/` (Apache-2.0). They are the same files openkey PR #491 uses. The historical verification clock is 1752552000.
