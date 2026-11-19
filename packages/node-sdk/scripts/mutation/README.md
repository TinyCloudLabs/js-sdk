# Mutation harness (TC-712)

`mutate.mjs` checks that the credentials tests kill each targeted mutant.

- Copies `src/`, `package.json`, `tsconfig.json` and `sdk-core/test-fixtures` into a temp dir per process, so the working tree is never edited.
- Runs an unmutated preflight first. It aborts with exit 2 if the suite is red.
- `guard-specs.json`: guard and branch mutants. `pin-specs.json`: descriptor pin mutants.
- Env `CONC` sets parallelism (default 16).

Usage, from `packages/node-sdk`: `node scripts/mutation/mutate.mjs scripts/mutation/guard-specs.json`.

Specs marked equivalent or unreachable in the TC-712 report are expected to survive. Each has a stated reason there.
