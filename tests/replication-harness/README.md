# Replication harness (TC-893)

Deterministic, Docker-backed test harness for TinyCloud replication. It runs
scenario tiers (`core`, `edge`, `speed`, `tc12`) plus named sets
(`phase1-companion`) against real node topologies on SQLite and PG16 backends,
and produces leg reports and a canonical aggregate verdict for the Phase 1
gates. The binding contract is [`CONTRACTS.md`](./CONTRACTS.md); the CI
commands it lists are the source of truth for
`.github/workflows/replication-harness.yml`.

```
tests/replication-harness/
  bin/harness.ts        # run | list | manifest | resolve | aggregate | verify-aggregate | doctor | gc
  src/contracts/        # frozen interfaces (S0)
  src/topology/         # Docker topology (S1)
  src/runner/           # scheduler, leg reports (S3a)
  src/gate/             # resolve, manifest, aggregate, verify-aggregate (S3b)
  defaults.json         # image pins (default/previous/ciPin), Postgres, Toxiproxy
  quarantine.json       # [] — an entry needs a ticket; a core entry fails the gate
```

Every command is `bun run --cwd tests/replication-harness harness <cmd>` from
the repository root.

## Prerequisites

- Bun 1.3.x and Node 22.
- **Docker.** The harness invokes `DOCKER` (split on whitespace), defaulting
  to `sudo -n docker`, which is the dev-host configuration. On GitHub runners
  the workflow sets `DOCKER=docker`.
- **`HARNESS_DOCKER=1`** opts the Docker-dependent tests in; without it the
  topology tests skip.
- **Gate commands inject a runtime module.** `resolve`, `run`, `aggregate`,
  and `run --gate` load the module named by `TC893_RUNTIME_MODULE`, which is
  resolved against the harness package directory — pass an absolute path or
  one relative to `tests/replication-harness`. The module must
  export `registerGateRuntime(configureGateRuntime)` and register the SUT and
  image resolvers, the SUT artefact exporter, the topology factory, and the
  run-environment builder (see CONTRACTS.md). The production module is
  assembled by the runtime-assembly slices; `test/fixtures/gate-cli-runtime.ts`
  is the fixture example. Unit tests that don't touch Docker run without it.
- Check the environment with `harness doctor` and reclaim leaked resources
  with `harness gc`.

## Running locally

On the dev host, enable Docker for the harness and tests:

```bash
export HARNESS_DOCKER=1        # enable Docker-backed tests
export DOCKER="sudo -n docker" # default; passwordless docker on the dev host
bun run --cwd tests/replication-harness harness doctor
```

### Listing

```bash
bun run --cwd tests/replication-harness harness list [--tier core] [--backend sqlite] [--set phase1-companion] [--only CORE-01]
```

### One tier, both SUT modes

`harness run` executes a resolve → leg → aggregate sequence against a locally
resolved SUT.

```bash
# Workspace SUT (the checked-out, built packages)
bun run --cwd tests/replication-harness harness run --tier core --backend sqlite,pg16

# Published SUT (exact versions, never dist-tags)
bun run --cwd tests/replication-harness harness run --tier core --backend sqlite,pg16 \
  --clients published --cli 1.1.0-beta.24 --node-sdk 3.1.0-beta.15

# Other tiers and sets
bun run --cwd tests/replication-harness harness run --tier edge
bun run --cwd tests/replication-harness harness run --tier tc12
bun run --cwd tests/replication-harness harness run --tier speed --backend sqlite   # dispatch-scale; long
bun run --cwd tests/replication-harness harness run --set phase1-companion
```

Published mode requires `--cli` and `--node-sdk` exact SemVer versions; `beta`
and ranges are rejected at resolve.

### Local gate (diagnostic)

```bash
bun run --cwd tests/replication-harness harness run --gate tc858-phase1-workspace
```

`run --gate` performs the same resolve → legs → aggregate hooks as CI. Its
aggregate is **diagnostic**: the only canonical gate verdict is the CI
`aggregate` job. An interrupted or cancelled core leg fails the local core
conclusion even if every serialized row passes.

### Tests and typecheck

```bash
bun run --cwd tests/replication-harness typecheck
bun run --cwd tests/replication-harness test
```

With `HARNESS_DOCKER=1` and working `sudo -n docker`, the topology integration
tests also run.

## Adding a scenario

1. Create `src/scenarios/<tier>/<id>.ts` and register it via
   `registerScenarios` (see `src/runner/registry.ts`). A `Scenario` needs a
   unique `id` (`CORE-NN`, `EDGE-NN`, `SPEED-NN`, `TC12-NN`), `title`, `tier`,
   `timeoutMs`, `topology`, and `run`.
   - `backends` restricts the backend list (default: all three of
     `sqlite`/`pg16`/`pg16-c`).
   - `variants` expands one scenario into labelled variants;
     `appliesTo?(run, variant)` may return a string reason to mark a row
     `unsupported`.
   - `sets: ["phase1-companion"]` puts the scenario in the companion set.
     Companion rows never affect `gate.passed`.
   - `requires` declares requirement probes (production `/info`, SUT
     capabilities); unmet requirements mark the row `unsupported` rather than
     `fail`.
2. Write the topology with `TopologySpec` (`validateTopology` enforces unique
   identities/aliases, prefix shape and overlap, SDK-only options, grant
   issuer order, and minimum expiry) and drive `KvClient`s from the shared
   `ScenarioContext`. No wall-clock sleeps: deadlines derive from the injected
   `Clock` and configured bounds.
3. Run it for real before opening a PR:
   `HARNESS_DOCKER=1 bun run --cwd tests/replication-harness harness run --only <ID> --backend sqlite,pg16`
   and confirm `report.json`/`report.md` show `pass` on both backends.
4. Quarantine only as a last resort: add `{id, reason, ticket}` to
   `quarantine.json`. A quarantined **core** row fails the gate.

## CI

`.github/workflows/replication-harness.yml` runs `resolve` → `leg-core` +
`leg-companion` (matrix, `fail-fast: false`) → `aggregate`. It triggers on:

- `workflow_dispatch` with inputs `gate`, `tier`, `set`, `backends`,
  `clients`, `cli_version`, `node_sdk_version`, `node_image`, `only`;
- `pull_request` types `labeled`/`synchronize`, gated on the `replication`
  label. A labelled PR always resolves `gate=tc858-phase1-workspace`,
  `set=phase1-companion`, `clients=workspace`, image `prod` (G1).


The `replication` label is reserved for G1 on the TC-858 Phase 1
integration-to-master PR. Harness-only PRs targeting `master` are not labelled
`replication` until Phase 1 is on `master`.
There is no schedule. Core legs and companion legs are separate jobs;
`aggregate` receives `--leg-core-conclusion` and `--leg-companion-conclusion`
independently (`--leg-jobs-conclusion` was removed). `gate.passed` is
computed only from the core legs; the companion result is a separate section
of the aggregate. Artefacts: `tc893-inputs`, `tc893-leg-<name>` per leg, and
`tc893-aggregate`.

## Phase 1 gate runbook

### G1 — pre-publish, on the integration PR

1. Preconditions: the integration slices and the junit-evidenced real-node
   suites are merged and green on the PR head SHA.
2. Trigger: apply the `replication` label. Every `synchronize` push reruns.
3. Pass: the `aggregate` check is green with `gate.passed=true`;
   `inputs.subject.headSha` equals the PR's current head SHA and `baseSha`
   the merge base. Evidence is valid only for that `(headSha, baseSha)` pair;
   rerun if master advanced.
4. Evidence: comment on TC-858 with the run URL, head/base/merge SHAs,
   `sha256(aggregate.json)`, the verdict and companion verdict, the SUT
   `gitSha`/`distSha256`, the image digest, and the real-node suite run URL
   with junit counts.
5. The integration PR does not merge until G1 passes.

### G2 — post-publish

1. Resolve the exact versions **once**:
   `npm view @tinycloud/cli@beta version` and
   `npm view @tinycloud/node-sdk@beta version`. This is the only place `beta`
   is resolved.
2. Dispatch the workflow on master with `gate=tc858-phase1-beta`,
   `clients=published`, `cli_version=<exact>`, `node_sdk_version=<exact>`,
   `set=phase1-companion`. The image is forced to `prod`.
3. Pass: `aggregate` green, `gate.passed=true`, and `aggregate.legs` shows
   both backends with identical `inputsSha256`.
4. Consume the aggregate, then run the production smoke. The version is
   checked before the smoke ever runs — fail fast on exit 3 (gate failed),
   4 (production drift), 5 (companion failure: stop and escalate), and on any
   output that isn't an exact SemVer:

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

   `verify-aggregate --print cli.version` writes **only** the version to
   stdout; diagnostics go to stderr. The smoke script lives in the meta repo
   and requires an explicit exact version — never `beta`.
5. Stop conditions:
   - exit 4 (production drift): rerun G2;
   - exit 5 (companion failed): stop before the smoke and escalate to Sam and
     the coordinator;
   - G2 failed (exit 3): no smoke; the fix ships as a new beta and G2 reruns.
6. Evidence: comment on TC-858 with the run URL, `sha256(aggregate.json)`,
   the exact CLI and node-sdk versions with their integrity, the image digest
   and production version, the companion verdict, and the production smoke's
   `REPLICATION FLAG STEP PASSED` line with the resolved CLI version.
