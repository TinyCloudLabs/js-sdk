# Provenance — policy-engine denial conformance package (m1-g-01)

Vendored byte-identical from TinyCloudLabs/policy-engine
`crates/policy-engine-http/conformance/` at commit
`ba318116365171f3be19de4e3efa1a5eafd842d2` (branch
`smithers/data-exchange/m1-wave-7c/m1-integration`, the merged m1-g-01
output; amendments 26-28). Label: confirmed from code @ ba318116.

Consumption rules (amendment 28, binding on m1-g-03): only
`denial-matrix-v0.json` rows with `reachability == "mounted-runtime"` are
expectable wire codes; `FROZEN-VOCABULARY/UNREACHABLE` rows
(canonicalization-mismatch, evidence-freshness-expired) must NEVER appear
in expected mapping/fixture sets; the v0 expired-credential expectation is
`evidence-credential-invalid`. Wire fixtures carry per-file sha256 in
`wire-denials/manifest.json`.
