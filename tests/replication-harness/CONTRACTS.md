# Replication harness contracts

The `src/contracts/` interfaces follow §4 of `tc893-harness-plan.md`; schema files validate the serialized gate inputs, manifest, leg report, aggregate, and baseline.

## Decisions

- **SUT/image/client entry points:** S2 exports `SutResolver`, `ImageResolver`, and `ClientConstructor` as the single injectable entry points in `src/contracts/frozen.ts`. SUT and image resolution happen once per run; `ImageResolver` accepts the full `NodeImageRef` union. Client construction consumes the resolved SUT/image and its `ClientSpec`.
- **Shared identity fixture:** `ClientSpec.endpoint`, `storageRoot`, and `deviceProof` carry explicit client overrides. `prepareSharedEndpointStorageDeviceSpec` patches the two SDK client specs before `createTopology`; it requires the same identity and replication enabled, sets one canonical endpoint and replica root, foreground mode, and distinct device proofs. The S2/S6 fixture factory receives a topology-creation callback and returns the topology plus both clients. Reopening A requires `refresh: false`.
- **Restart semantics:** every `KvClient.restart` call explicitly selects `auth: "restore"` or `auth: "fresh-sign-in"`. Restore opens a fresh process on the same storage with the saved session/delegation proof (including the combined device proof); fresh sign-in is an owner re-authentication in a fresh process on that same storage. Neither mode falls back to the other. Initial construction signs in; EDGE-31 explicitly restores the same saved grant.
- **Client process and host authority:** CLI and SDK child processes run under Node, not Bun. A host alias resolves through the client-specific proxy edge. Owner CLI host clones sign in with the same local key; delegate CLI host clones import the device's saved portable grant into a host-specific profile. SDK owner host clones sign in again with the same owner key at the target endpoint; SDK delegates restore only their own device proof. Neither path shares an owner session with a device profile.
- **Authority expiry and event evidence:** SDK session expiry is read from signed SIWE `Expiration Time` when the persisted session omits an explicit expiry. CLI grant imports persist their returned expiry for `authority()`. Client homes and credentials stay outside exported results; each client writes `stderr.log` and `events.jsonl`.
- **SDK purge lifecycle:** after `replication.purge()` completes with no failed prefixes, the driver closes the replication controller. Subsequent `status()` returns no active replicas rather than stale idle entries.
- **CLI network-only reads:** `get({ source: "network" })` uses the CLI's `--no-replication` override so a configured profile cannot serve the value from its local replica.
- **CLI multi-host reports:** `replica report --json` combines partition summaries from the active profile and already-established `withHost` profiles; credential profiles remain separate.
- **SDK replica directory security:** SDK replica storage contains `device.jwk` with the device private key. A shared-fixture `replicaRoot` must remain outside the results tree and all exported artefacts.
- **Gate job conclusions:** core runs in `leg-core`, companion runs in `leg-companion`. `gate.passed` is true iff `legCoreConclusion === "success"` and the core verdict has no reason codes. Companion verdicts and conclusions never affect that predicate.
- **JUnit evidence:** inputs carry a versioned `tc893.junit-precondition/v1` record for G1. Version 1 requires named suites `cli-acceptance-sqlite` (≥1), `cli-acceptance-pg16` (≥1), `node-sdk-real-node-sqlite` (≥10), and `node-sdk-real-node-pg16` (≥10); every suite must exist, exit successfully, and have zero skips. The PR number, head SHA, and base SHA must exactly equal the inputs subject association. Dispatch evidence must match its subject event, ref, and SHA. Local diagnostics carry no junit precondition.
- **Capture artefacts:** every required capture file must exist and have the SHA-256 declared by the leg report. Zero-byte log and JSONL captures are valid; other required captures must be non-empty.
- **Client capture redaction:** before a scenario, the runner registers S2 identity-store keys, client-provided secret values, sensitive client-spec values, and persisted key/profile/session/delegation JSON. Client capture files are staged outside the report tree, redacted, copied to `clients/<id>/stderr.log` and `clients/<id>/events.jsonl` under the row artefact directory, then indexed by size and SHA-256. S2 client homes remain outside results.
- **Detached checkout reports:** report `subject.ref` uses the current branch when available, then the symbolic ref, and falls back to the checked-out SHA for detached `HEAD`.
- **Aggregate output:** `verify-aggregate --print cli.version` writes only an exact SemVer 2.0.0 version to stdout; diagnostics go to stderr. Ranges, tags, a `v` prefix, and invalid numeric prerelease identifiers are rejected.
- **Topology validation:** validate identities, references, prefix shape/overlap, SDK-only options, grant issuer order/identity/posture, and minimum expiry. Alias ids are globally unique against node/client ids and other aliases.
- **Image pin detail:** the plan abbreviates the previous image digest (`781434c5…`), so S0 records its exact 1.19.2-dstack tag without inventing a digest; S1 resolves and records the digest before use. The plan's default digest and CI pin are recorded as given.
- **Serialized aggregate evidence vs manifest completeness:** when `gate.passed` is true, the schema requires exactly one core leg for each input backend, matching `inputsSha256`, and every serialized core row to pass without quarantine or missing artefacts. The schema can only validate rows present in the aggregate; S3b recomputes the full manifest to catch rows omitted entirely and verifies downloaded file existence and hashes.

## CI commands for S5

The workflow calls the harness commands directly; CI YAML contains no gate logic.

```sh
# resolve job (uploads tc893-inputs, including the matrix output)
bun run --cwd tests/replication-harness harness resolve \
  --event-file "$GITHUB_EVENT_PATH" --dispatch-inputs "$DISPATCH_INPUTS" \
  --out "$RUNNER_TEMP/tc893/in"

# leg-core job; its matrix is the core-* entries, one leg per backend
bun run --cwd tests/replication-harness harness run \
  --inputs "$IN/inputs.json" --leg "${{ matrix.name }}" \
  --results "$RUNNER_TEMP/tc893/leg"

# leg-companion job; its matrix is the companion-* entries
bun run --cwd tests/replication-harness harness run \
  --inputs "$IN/inputs.json" --leg "${{ matrix.name }}" \
  --results "$RUNNER_TEMP/tc893/leg"

# aggregate job downloads all legs and receives independent job conclusions
bun run --cwd tests/replication-harness harness aggregate \
  --inputs "$IN/inputs.json" --legs "$RUNNER_TEMP/legs" \
  --leg-core-conclusion "$CORE_RESULT" \
  --leg-companion-conclusion "$COMPANION_RESULT" \
  --out "$RUNNER_TEMP/agg"
```

The matrix emitted by `resolve` has `{name, backend, set, tiers}` entries such as
`core-sqlite`, `core-pg16`, `companion-sqlite`, and separate `speed-sqlite`.
For non-gate dispatches, resolve preserves the selected tiers and backends,
groups non-speed tiers per backend, and emits speed as a separate
`speed-<backend>` leg.
`harness run --gate` uses the same resolve → in-process leg hook → aggregate
sequence locally; its aggregate is diagnostic, not canonical CI evidence.
`resolve` writes `inputs.json`, `matrix.json`, and the core/companion manifests
to `--out`; it prints the compact matrix JSON and appends `matrix=<JSON>` to
`$GITHUB_OUTPUT` when running under Actions. `run --inputs ... --leg ...`
selects that matrix entry from the resolve artefacts and writes
`<results>/report.json` and `report.md`. `aggregate --legs` reads one
`<leg-name>/report.json` directory per matrix leg, recomputes the registry
manifests, and writes `aggregate.json` and `aggregate.md` under `--out`.
When the matrix lists no companion legs, `aggregate` treats a `skipped` `--leg-companion-conclusion` as `success` (the `leg-companion` job is skipped via `has-companion`); with companion legs in the matrix, `skipped` still fails.

`manifest --inputs "$IN/inputs.json" --out "$RUNNER_TEMP/tc893/manifest"`
recomputes and writes `manifest-core.json`; add `--set phase1-companion` to
write the companion manifest. The command adapters use S3a's `scenarioRegistry`
for manifest recomputation and leg selection.

Runtime services that are owned by S1/S2 are injected, not mocked in
production. The module named by `TC893_RUNTIME_MODULE` must export
`registerGateRuntime(configureGateRuntime)` and register the frozen SUT/image
resolvers, SUT artefact exporter, topology factory, and run-environment
builder. The builder verifies the downloaded workspace dist or published
install against `RunInputs` before returning; the runner adapter also rejects
a different SUT identity or image digest. It may also supply production
`/info`, junit evidence, and requirement probes. This keeps topology and
client construction replaceable while the gate CLI and aggregation remain
executable.

`harness run --gate <id>` invokes the same resolve → S3a runner → aggregate
hooks locally. An interrupted or cancelled core leg fails the local core
conclusion even if every serialized row says `pass`.


`aggregate` exits 0 when the core gate passes, 3 when it fails, and 1 when
a non-gate run has any non-passing or quarantined row, a failed or
cancelled leg-job conclusion, or missing, unreadable, or mismatched
matrix evidence (a leg absent from the matrix, an extra leg, an
unparseable or schema-invalid `report.json`, or a mismatched
`inputsSha256`). An invalid leg report never aborts aggregation: it
fails the conclusion and verdict for its set (`MISSING_LEG`), so a
gate run exits 3 with `gate.passed=false`. Companion verdicts do not
alter the core gate exit
status; `verify-aggregate` maps companion failure to the separate
escalation status 5.

### D1 fail-fast production smoke

`verify-aggregate --print cli.version` writes only the exact CLI SemVer to
stdout. It exits 3 for a gate failure, 4 for production version drift, and 5
when the core gate passes but a companion verdict fails (stop and escalate).
All diagnostics go to stderr.

```bash
set -euo pipefail
RUN=<G2 run id>
gh run download "$RUN" -R tinycloudlabs/js-sdk -n tc893-aggregate -D g2
ver=$(bun run --cwd tests/replication-harness harness verify-aggregate \
  "$PWD/g2/aggregate.json" --gate tc858-phase1-beta --run-id "$RUN" \
  --print cli.version) || exit 1
node -e 'const v=process.argv[1]; const m=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(v); const p=m?.[4]?.split(".")??[]; if(!m||p.some(x=>/^\d+$/.test(x)&&x.length>1&&x[0]==="0"))process.exit(1)' "$ver" || {
  printf 'verify-aggregate returned a non-exact SemVer: %s\n' "$ver" >&2
  exit 1
}
scripts/replication/rc1-prod-smoke-cli.sh "$ver"
```

The smoke receives a checked, explicit version only. Empty output, tags, ranges,
and values with a `v` prefix are rejected before the smoke can run.
