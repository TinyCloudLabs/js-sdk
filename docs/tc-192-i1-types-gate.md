# TC-192 I1 TypeScript Gate

`.github/workflows/tc-192-i1-types-gate.yml` keeps the complete
`packages/operations` TypeScript program strict-clean, including its tests.
It runs the package `typecheck` script through the root
`typecheck:operations` stage command; no test files are excluded and no
compiler option is relaxed.

The gate pins Bun `1.2.0`, verifies that pin before installing with the locked
dependency graph, emits the public SDK runtime entrypoints needed by the
invocation suite, and emits the Node SDK runtime entrypoint required by the
legacy CLI concurrency suite. It then typechecks, builds, tests, and verifies
the generated operations catalog. The invocation test imports
`jcsCanonicalize` from the `@tinycloud/sdk-core` package root, so the gate
intentionally does not reach into SDK source files.
