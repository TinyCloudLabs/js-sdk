# Mutation harness (TC-712)

`mutate.mjs` checks that the credentials tests kill each targeted mutant.

- Copies `src/`, `package.json`, `tsconfig.json` and `sdk-core/test-fixtures` into a temp dir per process, so the working tree is never edited.
- Runs an unmutated preflight first. It aborts with exit 2 if the suite is red.
- `guard-specs.json`: guard and branch mutants. `pin-specs.json`: descriptor pin mutants.
- Env `CONC` sets parallelism (default 16).

Usage, from `packages/node-sdk`: `node scripts/mutation/mutate.mjs scripts/mutation/guard-specs.json`.

## Staged witness-key replacement

The issuer pin draft is blocked while `issuerX` is `UNKNOWN_NEW_WITNESS_KEY`.
That value is intentionally not a 32-byte Ed25519 key; do not merge or release it.

When the verified replacement witness key is available:

1. Keep `did:web:issuer.credentials.org#controller`, both descriptor digests, and the witness origin unchanged.
2. Set the same canonical 32-byte Ed25519 JWK `x` in `src/credentials/pins.ts` and `src/credentials/test-support/issuer-did.json`. Keep a single verification method, with no previous-key overlap.
3. Regenerate only the `pin.issuerX[...]` mutations for the replacement bytes in `pin-specs.json`; keep their target `src/credentials/pins.ts` and retain the previous-key-restored mutant.
4. Replace the draft-only unusable-key assertion in `stored-tamper.test.ts` with a real pre-replacement credential rejection and a fresh replacement-key credential acceptance. Do not substitute a test issuer for those cutover checks.
5. Run the credential and pending-store suites, then `node scripts/mutation/mutate.mjs scripts/mutation/pin-specs.json`. Resolve the dedicated changeset ticket reference before publication.

Specs marked equivalent or unreachable in the TC-712 report are expected to survive. Each has a stated reason there.
