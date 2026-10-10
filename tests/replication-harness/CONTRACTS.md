# Replication harness contracts

The `src/contracts/` interfaces follow §4 of `tc893-harness-plan.md`; schema files validate the serialized gate inputs, manifest, leg report, aggregate, and baseline.

## Decisions

- **SUT/image/client entry points:** S2 exports `SutResolver`, `ImageResolver`, and `ClientConstructor` as the single injectable entrypoints in `src/contracts/frozen.ts`. Resolution occurs once per run; construction consumes the resolved SUT and image. S1/S2 may implement these contracts but should not introduce competing public entry points.
- **Shared identity fixture:** S2 exports `SharedFixtureFactory`; it binds both devices to one canonical endpoint and replica root, preserves foreground mode, and exposes reopen with `refresh: false` so reopening A cannot refresh before the disconnect. Device proofs remain separate.
- **Restore semantics:** `auth.restore: "persist"` is the default; a restart restores saved session/delegation proof in a fresh process. `"none"` opts out. Fresh sign-in is a separate initial construction operation and is never a restart fallback.
- **Gate job conclusions:** core runs in `leg-core`, companion runs in `leg-companion`. `gate.passed` is computed only from core jobs and the core manifest. Companion verdicts are reported independently and never mutate gate reasons or passed state. Their conclusions are recorded separately in `legCoreConclusion` and `legCompanionConclusion`.
- **JUnit evidence:** inputs carry a versioned `tc893.junit-precondition/v1` record. Version 1 requires the named suites, successful process, zero skips, and per-suite minimums (CLI ≥1; SDK ≥3); it binds the tested SHA to PR head/base SHAs (or a dispatch ref/SHA). The precondition is null outside G1.
- **Capture artefacts:** every required capture file must exist and have the SHA-256 declared by the leg report. A zero-byte capture is valid; no events or diagnostics are manufactured to satisfy the manifest.
- **Aggregate output:** `verify-aggregate --print cli.version` writes only the exact non-tag semver to stdout; diagnostics go to stderr. Empty values, tags, ranges, and other non-exact semver inputs are rejected.
- **Minimal topology validation:** validate identities, references, prefix shape/overlap, SDK-only options, grant issuer order/identity/posture, and minimum expiry. Alias ids are globally unique against node/client ids and other aliases.
- **Image pin detail:** the plan abbreviates the previous image digest (`781434c5…`), so S0 records its exact 1.19.2-dstack tag without inventing a digest; S1 resolves and records the digest before use. The plan's default digest and CI pin are recorded as given.
