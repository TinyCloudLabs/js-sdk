# held-presentation-v1 fixture

`presentation.json` holds one verifier case in the shape of OpenCredentials
`rust/opencredentials_witness/specs/held-presentation-v1/verifier-vectors.json` (`cases[]` entry:
`now_ms`, `audience`, `caller_account`, `accepted_issuers`, `did_methods`, `issuer_set`,
`seeded_nonce`, `presentation`, `expected`).

- Audience `credentials.org`; nonce `a1b2c3d4e5f6a7b8c9d0e1f2` (hex, 24 characters).
- The credential and issuer set are the `held-email-v1/vector.json` credential with only the `email`
  disclosure kept (`selectDisclosures`).
- The SIWE message and signature come from `buildHeldPresentationSiwe`, signed with the public Anvil
  account 0 key (test only). Signing is deterministic, so `presentation-vector.test.ts` rebuilds the
  presentation and compares it with this file.
- The Rust verifier (OpenCredentials `held_presentation`) has NOT been run against this file here.
  Drop the `case` object into that repo's `verifier-vectors.json` to replay it.
