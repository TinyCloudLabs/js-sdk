---
"@tinycloud/tee-verify": minor
---

New package `@tinycloud/tee-verify` with a `tinycloud-tee-verify <url>` command. It checks a TinyCloud service's `/attestation` response and refuses, saying why, unless all of these hold:

- the quote binds your nonce and the signer you expect;
- Intel's signature verifies and the TCB is up to date;
- the TD is not in debug mode;
- the replayed event log matches the quote;
- the OS image and measurements are on the published production list;
- the app ID and compose hash are a published release.

The production OS list is empty until the node moves to the production OS, so the node is refused for now. `--service openkey` checks OpenKey's route (`https://api.openkey.so`, signer derived from its JWKS); OpenKey has no published release yet, so it is refused too. Nothing in the SDK or CLI calls this package yet.

Details: TC-3841
