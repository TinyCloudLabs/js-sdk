# held-email-v1 fixtures

Known-answer data for the held email credential verifier tests.

- `vector.json`: byte-identical copy of the node-server fixture
  `tests/fixtures/held-email-v1/vector.json` at commit
  `922f02f38741c6a31d3914584eeec1e55445629d` (verified with `cmp`).
- `sd-hash.json`: the `base-valid` case of `s1-differential.json` from the same node
  commit, extracted to three fields: `source`, `sdJwt`, `sdHash`. The `sdHash` field is the
  bare base64url SHA-256 of the ASCII bytes of `sdJwt` (no prefix, no padding), as computed by
  `gen-s1-differential.mjs`.

Regenerate only from the pinned node commit above.
