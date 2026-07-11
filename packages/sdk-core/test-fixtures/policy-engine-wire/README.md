# Policy Engine HTTP wire fixtures (PM base-prep, m1-wave-6b)

Label: **confirmed from code: policy-engine service implementation @
`8c4cabbf5`** (the M1 promotion surface,
`smithers/data-exchange/m1-wave-5/m1-integration`). These are NOT frozen
contract vectors — the frozen `spec/` + `test-vectors/` tree carries the
presentation-level objects (`test-vectors/grant-presentation/accept.json` /
`reject.json`); the HTTP envelope truth captured here lives in
`crates/policy-engine-http`. A frozen-tree wire amendment may follow at CP-F;
until then these fixtures are the authoritative requester grounding.

Provenance: generated 2026-07-09 by a PM fixture-emitter test appended to the
crate's own `mod tests` in a scratch worktree at `8c4cabbf5` — every exchange
was produced by the real `Router`/handlers with the crate's own test config,
keys, and presentation builder, and asserted in-test before capture. Emitter
script preserved at the missoula session workspace
`.context/checkpoints/wire-fixture-emitter-2026-07-09.rs.txt`; not committed
to policy-engine.

Each `<case>.json` records `{name, note, request: {method, path, body},
response: {status, body}}`. `manifest.json` carries the producer commit,
per-file sha256, and the consumption rule: **every manifest case must be
consumed by at least one deterministic sdk-core test, asserted by a
manifest-completeness test.**

Cases: challenge happy (signed GrantChallenge envelope); challenge unknown
field → 422 `schema-invalid`; challenge unknown policy → 404
`policy-not-found`; resolve happy native → 200 `{delegation}` carrying the
prepared node-native compact-JWS UCAN; replay of an
evaluated presentation → 409 `challenge-nonce-consumed` (burned-nonce rule:
restart at /challenge); resolve unknown field → 422 `schema-invalid`; nonce
substituted without re-signing → 422 `holder-signature-invalid` (DQ-18);
well-formed wrong `requestedCapabilitiesHash` (re-signed) → 422
`requested-capabilities-hash-mismatch` (rev 3.20 amendment; nonce consumed).
